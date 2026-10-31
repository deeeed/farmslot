import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  Events,
  type EvidenceAttestationApprover,
  isTerminalRunStatus,
  type Run,
  type RunAttestBeforeAttemptParams,
  type RunAttestBeforeAttemptResult,
  sameEvidenceAttestationApprover,
  validateArtifactManifestDocument,
} from '@farmslot/protocol';

import { loadSlotVars } from '../../core/config.js';
import { GatewayMethodError } from '../../core/method-error.js';
import { slotFileExists, slotReadFile } from '../../core/slot-io.js';
import { resolveWorkerTaskDir } from '../../live-recipe/context.js';
import { commitRunBeforeAttemptAttestation, getRun } from '../../runs/store.js';

export interface BeforeAttemptAttestationDependencies {
  authorizeEvidenceAttestation?: () => EvidenceAttestationApprover;
  readAttemptManifest?: (run: Run, attemptRoot: string) => Promise<string | null>;
}

/** A refused attempt is not mirrored yet; read it from the run's own checkout, as the preflight does. */
async function readWorkerAttemptManifest(run: Run, attemptRoot: string): Promise<string | null> {
  const taskDir = await resolveWorkerTaskDir(run);
  if (!taskDir || !run.slotId) return null;
  const vars = await loadSlotVars(run.slotId);
  const file = path.join(taskDir, 'artifacts', attemptRoot, 'artifact-manifest.json');
  return (await slotFileExists(vars, file)) ? slotReadFile(vars, file) : null;
}

/** ADR-062 Amendment 21: admit one same-run attempt as before-only evidence, bound to its manifest. */
export async function runAttestBeforeAttempt(
  params: RunAttestBeforeAttemptParams,
  emit: (event: string, payload: unknown) => void,
  dependencies: BeforeAttemptAttestationDependencies = {},
): Promise<RunAttestBeforeAttemptResult> {
  if (!dependencies.authorizeEvidenceAttestation)
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'A credential-backed person must record this attestation.',
    );
  const authorize = dependencies.authorizeEvidenceAttestation;
  const approver = authorize();
  const reason = params.reason?.trim();
  if (!reason) throw new Error('A before attestation requires a written reason.');
  // A path under recipe-runs/ (`<id>` or the harness's `attempts/<id>`). Every segment
  // starts with a letter or digit, so `..`, hidden, empty and absolute segments are refused.
  if (!/^[A-Za-z0-9][\w.-]*(?:\/[A-Za-z0-9][\w.-]*)*$/u.test(params.recipeRunId ?? ''))
    throw new Error('Name one recipe attempt under artifacts/recipe-runs/.');
  const attemptRoot = `recipe-runs/${params.recipeRunId}`;
  const run = getRun(params.runId);
  if (!run || run.readOnly || isTerminalRunStatus(run.status))
    throw new Error('Only an active unresolved publish gate accepts before attestations.');
  const gate = (current: Run) => current.decisions.find(({ id }) => id === params.decisionId);
  const decision = gate(run);
  if (
    !decision ||
    decision.resolvedAt ||
    decision.type !== 'engine_human_gate' ||
    decision.payload?.kind !== 'ready'
  )
    throw new Error('The selected publish gate is unavailable.');
  const bytes = await (dependencies.readAttemptManifest ?? readWorkerAttemptManifest)(
    run,
    attemptRoot,
  );
  let manifest: unknown;
  try {
    manifest = bytes === null ? null : JSON.parse(bytes);
  } catch {
    // Unparseable bytes are not a recipe attempt; the validator below refuses them as such.
    manifest = null;
  }
  if (bytes === null || validateArtifactManifestDocument(manifest).status !== 'valid')
    throw new Error(`${attemptRoot} is not a recipe attempt captured by this run.`);
  const manifestSha256 = createHash('sha256').update(bytes).digest('hex');
  const matching = (current: Run) =>
    current.beforeAttemptAttestations?.find(
      (entry) =>
        entry.runId === current.id &&
        entry.attemptRoot === attemptRoot &&
        entry.manifestSha256 === manifestSha256 &&
        entry.reason === reason &&
        entry.approver.principalId === approver.principalId,
    );
  const assertCurrent = (current: Run) => {
    if (!sameEvidenceAttestationApprover(authorize(), approver))
      throw new Error('The authenticated attestation identity changed.');
    const currentDecision = gate(current);
    if (
      getRun(current.id) !== current ||
      isTerminalRunStatus(current.status) ||
      current.readOnly ||
      !currentDecision ||
      currentDecision.resolvedAt ||
      currentDecision.payload?.kind !== 'ready'
    )
      throw new Error('The publish gate changed while the attestation was being checked.');
    // Admitting the before side changes the package hash, so it binds only this commit.
    if (!matching(current) && currentDecision.payload.prPackage?.packageHash !== params.packageHash)
      throw new Error('The displayed gate package changed. Refresh before attesting.');
  };
  const attestation = await commitRunBeforeAttemptAttestation(
    run.id,
    (current) =>
      matching(current) ?? {
        id: randomUUID(),
        runId: run.id,
        decisionId: decision.id,
        attemptRoot,
        manifestSha256,
        approver,
        reason,
        attestedAt: new Date().toISOString(),
      },
    assertCurrent,
  );
  const updated = getRun(run.id)!;
  emit(Events.RUN_UPDATED, { run: updated });
  return { run: updated, attestation };
}
