import { randomUUID } from 'node:crypto';

import {
  selectedRecipeClaims,
  validateRecordedEvidencePackage,
} from '@farmslot/adapter-sdk/evidence';
import {
  acceptanceRowExecution,
  Events,
  type EvidenceAttestationApprover,
  isTerminalRunStatus,
  normalizeRecipeClaimId,
  projectClaimUntestableOverride,
  type Run,
  runClaimOverrideSnapshotIdentity,
  type RunOverrideClaimParams,
  type RunOverrideClaimResult,
  sameEvidenceAttestationApprover,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../../core/method-error.js';
import { assertQaCompletion } from '../../qa/completion.js';
import {
  appliedClaimOverrideReceiptIds,
  claimOverrideAuthority,
} from '../../run-engine/claim-overrides.js';
import { claimSourceInput } from '../../run-engine/claim-reviews.js';
import {
  readGateAcceptance,
  readGateRecordedEvidence,
} from '../../run-engine/gate-prerequisites.js';
import { commitRunClaimOverride, getRun } from '../../runs/store.js';

export interface ClaimOverrideDependencies {
  authorizeEvidenceAttestation?: () => EvidenceAttestationApprover;
  acceptance?: typeof readGateAcceptance;
  evidence?: typeof readGateRecordedEvidence;
}

export async function runOverrideClaim(
  params: RunOverrideClaimParams,
  emit: (event: string, payload: unknown) => void,
  dependencies: ClaimOverrideDependencies = {},
): Promise<RunOverrideClaimResult> {
  if (!dependencies.authorizeEvidenceAttestation)
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'A credential-backed person must record this override.',
    );
  const authorize = dependencies.authorizeEvidenceAttestation;
  const approver = authorize();
  const reason = params.reason?.trim();
  if (!reason) throw new Error('An untestable override requires a written reason.');
  const claimId = normalizeRecipeClaimId(params.claimId);
  const run = getRun(params.runId);
  if (!run || run.readOnly || isTerminalRunStatus(run.status))
    throw new Error('Only an active unresolved evidence gate accepts claim overrides.');
  const decision = run.decisions.find(({ id }) => id === params.decisionId);
  if (
    !decision ||
    decision.resolvedAt ||
    !['engine_human_gate', 'engine_output_review'].includes(decision.type)
  )
    throw new Error('The selected human evidence gate is unavailable.');
  const snapshotIdentity = runClaimOverrideSnapshotIdentity(decision);
  const prepared = decision.payload?.kind === 'ready' ? decision.payload.prPackage : undefined;
  const qa =
    !prepared && run.flowType === 'qa'
      ? await assertQaCompletion(run, { retained: true })
      : undefined;
  const inputs = await (dependencies.evidence ?? readGateRecordedEvidence)(
    run,
    prepared ?? null,
    qa,
  );
  if (
    !inputs.length ||
    inputs.some((input) => validateRecordedEvidencePackage(input).status !== 'valid')
  )
    throw new Error('The selected recorded evidence failed integrity validation.');
  const input = inputs.find((input) => input.claims?.recipeRunId === params.recipeRunId);
  const claim = input && selectedRecipeClaims(input).find(({ id }) => id === claimId);
  // A repair may select a retained original; the override binds to that execution.
  const sourceInput = input && claimSourceInput(input, claimId);
  if (!input || !claim || !sourceInput?.claims)
    throw new Error('The claim is absent from the selected recorded execution.');
  const sourceRunId = sourceInput.claims.recipeRunId;
  const acceptance = await (dependencies.acceptance ?? readGateAcceptance)(run);
  const taskRow = acceptance.ledger?.criteria.find(({ id }) => id === claim.id);
  if (
    acceptance.error ||
    acceptance.issues.length ||
    acceptance.ledger?.schemaVersion !== 2 ||
    // A QA row binds to its own case execution; any other row to the projection.
    (taskRow
      ? acceptanceRowExecution(acceptance.ledger, taskRow)
      : acceptance.ledger.recipeRunId) !== params.recipeRunId ||
    !acceptance.criteria.some(({ id, text }) => id === claim.id && text === claim.text)
  )
    throw new Error('The selected claim does not match the registered task execution.');
  if (
    !taskRow ||
    taskRow.overrides !== undefined ||
    taskRow.verdict !== claim.verdict ||
    taskRow.text !== claim.text
  )
    throw new Error(
      'Unverified task overrides or changed projections require a canonical engine projection.',
    );
  const authority = claimOverrideAuthority(run, sourceInput);
  const rechecked = await (dependencies.evidence ?? readGateRecordedEvidence)(
    run,
    prepared ?? null,
    qa,
  );
  const checked = rechecked.find(
    (candidate) => candidate.claims?.recipeRunId === params.recipeRunId,
  );
  const checkedSource =
    checked && validateRecordedEvidencePackage(checked).status === 'valid'
      ? claimSourceInput(checked, claimId)
      : undefined;
  if (
    !checkedSource ||
    claimOverrideAuthority(run, checkedSource).closureIdentity !== authority.closureIdentity
  )
    throw new Error('Selected evidence changed while the override was being checked.');
  const matching = (current: Run) =>
    current.claimOverrideReceipts?.find(
      (receipt) =>
        receipt.runId === current.id &&
        receipt.claimId === claim.id &&
        receipt.recipeRunId === sourceRunId &&
        receipt.closureIdentity === authority.closureIdentity &&
        receipt.reason === reason &&
        receipt.approver.principalId === approver.principalId,
    );
  const assertCurrent = (current: Run) => {
    const person = authorize();
    if (!sameEvidenceAttestationApprover(person, approver))
      throw new Error('The authenticated override identity changed.');
    const currentDecision = current.decisions.find(({ id }) => id === params.decisionId);
    if (
      getRun(current.id) !== current ||
      isTerminalRunStatus(current.status) ||
      current.readOnly ||
      !currentDecision ||
      currentDecision.resolvedAt ||
      runClaimOverrideSnapshotIdentity(currentDecision) !== snapshotIdentity
    )
      throw new Error('The evidence gate changed while the override was being checked.');
    if (!matching(current) && snapshotIdentity !== params.snapshotIdentity)
      throw new Error('The displayed gate snapshot changed. Refresh before overriding.');
  };
  assertCurrent(run);
  const receipt = await commitRunClaimOverride(
    run.id,
    (current) =>
      matching(current) ?? {
        id: randomUUID(),
        runId: run.id,
        decisionId: decision.id,
        claimId: claim.id,
        recipeRunId: sourceRunId,
        closureIdentity: authority.closureIdentity,
        priorVerdict: projectClaimUntestableOverride(
          claim,
          claimOverrideAuthority(current, sourceInput),
        ).verdict,
        approver,
        reason,
        overriddenAt: new Date().toISOString(),
      },
    assertCurrent,
    decision.payload?.kind === 'output-review'
      ? (snapshot) => appliedClaimOverrideReceiptIds(snapshot, inputs)
      : undefined,
  );
  const updated = getRun(run.id)!;
  emit(Events.RUN_UPDATED, { run: updated });
  return { run: updated, receipt };
}
