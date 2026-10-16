import {
  ACCEPTANCE_STATUS_ARTIFACT,
  isRecord,
  type ReadyGatePrPackage,
  type Run,
  WORKER_TERMINAL_CONTRACT_INPUT,
} from '@farmslot/protocol';

import { reviewPRIdentity } from '../review/session-mode.js';
import { getRunWithArchived } from '../runs/store.js';

import {
  sha256Text,
  verifyReadyGatePackageHash,
  verifyReadyGateSelectedEvidenceFiles,
} from './ready-gate-package.js';
import { readRetainedRunText } from './retained-artifacts.js';

export interface InheritedAcceptanceProvenance {
  source: 'parent-run';
  parentRunId: string;
  headSha: string;
  ledgerHash: string;
}

export interface InheritedAcceptanceSource {
  run: Run;
  prPackage: ReadyGatePrPackage;
  provenance: InheritedAcceptanceProvenance;
}

/** Select original proof authority; the normal gate still validates every claim. */
export async function readInheritedAcceptanceSource(
  run: Run,
): Promise<InheritedAcceptanceSource | null> {
  if (run.flowType !== 'pr-complete' || !run.parentRunId) return null;
  const childPr = reviewPRIdentity(run, { requirePRContext: true });
  const parent = await getRunWithArchived(run.parentRunId);
  if (!childPr || !parent || parent.project !== run.project || parent.id === run.id) return null;
  const gate = parent.engineState?.publishGate;
  const decision = parent.decisions.find(
    ({ payload, resolvedAt }) =>
      resolvedAt &&
      payload?.kind === 'ready' &&
      payload.prPackage?.packageHash === gate?.approvedPackageHash,
  );
  const payload = decision?.payload;
  if (
    parent.status !== 'done' ||
    !gate?.approvedPackageHash ||
    !['published_draft', 'published_ready'].includes(gate.publicationStatus ?? '') ||
    payload?.kind !== 'ready' ||
    !payload.prPackage ||
    !payload.prPackage.artifactBundle ||
    payload.repo?.toLowerCase() !== childPr.repository.toLowerCase() ||
    payload.prNumber !== childPr.prNumber
  )
    return null;
  const contract: unknown = JSON.parse(
    await readRetainedRunText(run, WORKER_TERMINAL_CONTRACT_INPUT),
  );
  if (
    isRecord(contract) &&
    isRecord(contract.acceptance) &&
    contract.acceptance.requireFresh === true
  )
    return null;
  const prPackage = payload.prPackage;
  if (!prPackage.headSha) throw new Error('Parent acceptance proof has no captured head');
  verifyReadyGatePackageHash(prPackage);
  await verifyReadyGateSelectedEvidenceFiles(parent, prPackage, [ACCEPTANCE_STATUS_ARTIFACT]);
  const ledger = await readRetainedRunText(
    parent,
    ACCEPTANCE_STATUS_ARTIFACT,
    prPackage.artifactBundle,
  );
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

export function inheritedAcceptanceMarkdown(proof: InheritedAcceptanceProvenance): string {
  return (
    `Acceptance proof inherited from run \`${proof.parentRunId}\` at head ` +
    `\`${proof.headSha}\`. Ledger SHA-256: \`${proof.ledgerHash}\`.`
  );
}
