import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ACCEPTANCE_STATUS_ARTIFACT,
  acceptanceCriteriaMatch,
  INHERITED_ACCEPTANCE_INPUT,
  type InheritedAcceptanceProvenance,
  isRecord,
  type ReadyGatePrPackage,
  registeredAcceptanceCriteria,
  type Run,
  type TaskInheritedAcceptanceReference,
  WORKER_TERMINAL_CONTRACT_INPUT,
} from '@farmslot/protocol';

import {
  getOrchestratorTaskRoot,
  loadProjectVars,
  resolveProjectTaskDirName,
  resolveTaskRelDir,
  type SlotVars,
} from '../core/config.js';
import { slotWriteFiles } from '../core/slot-io.js';
import { reviewPRIdentity } from '../review/session-mode.js';
import { assessRecordedAcceptance } from '../run-engine/acceptance-proof.js';
import { readVisualReviewPolicy } from '../run-engine/claim-reviews.js';
import { codeReviewCertifiesPackage } from '../run-engine/gate-policy.js';
import type { GateAcceptanceRead } from '../run-engine/gate-prerequisites.js';
import { readGateRecordedEvidenceSources } from '../run-engine/recorded-evidence-sources.js';
import { getRunWithArchived } from '../runs/store.js';
import { readFrozenWorkerTerminalContractForRun } from '../tasks/worker-terminal-contract.js';

import {
  resolveSelectedEvidenceRef,
  sha256Text,
  verifyReadyGatePackageHash,
  verifyReadyGateSelectedEvidenceFiles,
} from './ready-gate-package.js';
import { readOptionalRetainedRunText, readRetainedRunText } from './retained-artifacts.js';

export interface InheritedAcceptanceCandidate {
  run: Run;
  prPackage: ReadyGatePrPackage;
  provenance: InheritedAcceptanceProvenance;
}

export interface InheritedAcceptanceSource extends InheritedAcceptanceCandidate {
  acceptance: GateAcceptanceRead;
}

/** Select original proof authority; the normal gate still validates every claim. */
export async function readInheritedAcceptanceCandidate(
  run: Run,
): Promise<InheritedAcceptanceCandidate | null> {
  if (run.flowType !== 'pr-complete' || !run.parentRunId) return null;
  if (!registeredAcceptanceCriteria(run.ticketData?.acceptanceCriteria ?? []).length) return null;
  const childPr = reviewPRIdentity(run, { requirePRContext: true });
  const parent = await getRunWithArchived(run.parentRunId);
  if (!childPr || !parent || parent.project !== run.project || parent.id === run.id) return null;
  const parentPr = reviewPRIdentity(parent, { requirePRContext: true });
  if (
    !parentPr ||
    parentPr.repository.toLowerCase() !== childPr.repository.toLowerCase() ||
    parentPr.prNumber !== childPr.prNumber
  )
    return null;
  const gate = parent.engineState?.publishGate;
  const decision = parent.decisions.find(
    ({ payload, resolvedAt }) =>
      resolvedAt &&
      payload?.kind === 'ready' &&
      payload.prPackage?.packageHash === gate?.approvedPackageHash,
  );
  const payload = decision?.payload;
  if (
    !gate?.approvedPackageHash ||
    gate.prNumber !== childPr.prNumber ||
    !['published_draft', 'published_ready'].includes(gate.publicationStatus ?? '') ||
    payload?.kind !== 'ready' ||
    !payload.prPackage ||
    !payload.prPackage.artifactBundle ||
    payload.repo?.toLowerCase() !== childPr.repository.toLowerCase() ||
    parent.prNumber !== childPr.prNumber
  )
    return null;
  const contractText = run.artifactBundle
    ? await readRetainedRunText(run, WORKER_TERMINAL_CONTRACT_INPUT)
    : await readFrozenWorkerTerminalContractForRun(run);
  if (!contractText) return null;
  const contract: unknown = JSON.parse(contractText);
  if (
    isRecord(contract) &&
    isRecord(contract.acceptance) &&
    contract.acceptance.requireFresh === true
  )
    return null;
  const prPackage = payload.prPackage;
  // Inheritance requires the ledger to be in the approved manifest.
  if (!resolveSelectedEvidenceRef(ACCEPTANCE_STATUS_ARTIFACT, prPackage.evidenceManifest ?? []))
    return null;
  if (!prPackage.headSha) throw new Error('Parent acceptance proof has no captured head');
  verifyReadyGatePackageHash(prPackage);
  const ledger = await readOptionalRetainedRunText(
    parent,
    ACCEPTANCE_STATUS_ARTIFACT,
    prPackage.artifactBundle,
  );
  if (ledger === undefined) return null;
  await verifyReadyGateSelectedEvidenceFiles(parent, prPackage, [ACCEPTANCE_STATUS_ARTIFACT]);
  return {
    run: { ...parent, artifactBundle: prPackage.artifactBundle },
    prPackage,
    provenance: {
      source: 'parent-run',
      parentRunId: parent.id,
      headSha: prPackage.headSha,
      ledgerHash: sha256Text(ledger),
    },
  };
}

/** Reuse the gate's canonical engine, binding and review assessment. */
export async function readInheritedAcceptanceSource(
  run: Run,
): Promise<InheritedAcceptanceSource | null> {
  const source = await readInheritedAcceptanceCandidate(run);
  if (!source) return null;
  const { readGateAcceptance } = await import('../run-engine/gate-prerequisites.js');
  const acceptance = await readGateAcceptance(source.run);
  const inputs = (await readGateRecordedEvidenceSources(source.run, source.prPackage)).map(
    ({ input }) => input,
  );
  const assessed = assessRecordedAcceptance({
    reviewBinding: 'approved',
    run: source.run,
    acceptance,
    inputs,
    visualPolicy: await readVisualReviewPolicy(source.run),
    claimOverrideReceiptIds: source.prPackage.claimOverrideReceiptIds,
    visualJudgmentReceiptIds: source.prPackage.visualJudgmentReceiptIds,
    // The parent's recorded reviews at its approved package head.
    codeReviewCertified: codeReviewCertifiesPackage(source.run, source.prPackage),
  });
  const expected = registeredAcceptanceCriteria(run.ticketData?.acceptanceCriteria ?? []);
  if (
    acceptance.error ||
    acceptance.issues.length ||
    assessed.reasons.length ||
    !expected.length ||
    !acceptanceCriteriaMatch(expected, assessed.acceptance.criteria) ||
    assessed.acceptance.criteria.some(
      ({ id }) =>
        assessed.acceptance.ledger?.criteria.find((criterion) => criterion.id === id)?.verdict !==
        'proven',
    )
  )
    return null;
  return { ...source, acceptance: assessed.acceptance };
}

/** Stage only already-qualified proof references before worker delivery. */
export async function stageInheritedAcceptance(run: Run, vars: SlotVars): Promise<boolean> {
  if (!run.taskFile) return false;
  const source = await readInheritedAcceptanceSource(run);
  if (!source) return false;
  const project = await loadProjectVars(run.project);
  const relative = resolveTaskRelDir(
    run.taskFile,
    getOrchestratorTaskRoot(run.project, project.projectJson),
  );
  if (relative === null) throw new Error('Inherited acceptance task directory cannot be resolved');
  const reference: TaskInheritedAcceptanceReference = {
    schemaVersion: 1,
    ...source.provenance,
    childRunId: run.id,
    project: run.project,
    criteria: source.acceptance.criteria.map(({ id, text }) => ({ id, text })),
  };
  const text = `${JSON.stringify(reference, null, 2)}\n`;
  const local = path.join(path.dirname(run.taskFile), INHERITED_ACCEPTANCE_INPUT);
  await mkdir(path.dirname(local), { recursive: true });
  await writeFile(local, text);
  await slotWriteFiles(
    vars,
    path.posix.join(vars.remoteRepo, resolveProjectTaskDirName(project.projectJson), relative),
    [{ path: INHERITED_ACCEPTANCE_INPUT, content: Buffer.from(text).toString('base64') }],
  );
  if (run.acceptanceContractVersion === 1) {
    const { syncAcceptanceExecutionContract } =
      await import('../tasks/acceptance-execution-contract.js');
    const { readSlotField } = await import('../core/state.js');
    await syncAcceptanceExecutionContract(
      run,
      vars,
      path.posix.join(vars.remoteRepo, resolveProjectTaskDirName(project.projectJson), relative),
      path.dirname(run.taskFile),
      async () => (await readSlotField(vars.slotId, 'current_run_id')) === run.id,
    );
  }
  return true;
}

export function inheritedAcceptanceMarkdown(proof: InheritedAcceptanceProvenance): string {
  return (
    `Acceptance proof inherited from parent run \`${proof.parentRunId}\` at head ` +
    `\`${proof.headSha}\`. Ledger SHA-256: \`${proof.ledgerHash}\`.`
  );
}
