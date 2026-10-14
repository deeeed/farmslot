import { randomUUID } from 'node:crypto';

import {
  deriveReviewedRecipeClaims,
  validateRecordedEvidencePackage,
} from '@farmslot/adapter-sdk/evidence';
import {
  Events,
  type EvidenceAttestationApprover,
  normalizeRecipeClaimId,
  recordedEvidenceClosureIdentity,
  type Run,
  type RunReviewVisualClaimParams,
  type RunReviewVisualClaimResult,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../../core/method-error.js';
import { appliedVisualJudgmentReceiptIds } from '../../run-engine/claim-reviews.js';
import {
  readVisualReviewSource,
  visualReviewSnapshotIdentity,
} from '../../run-engine/recorded-evidence-sources.js';
import { commitRunVisualJudgment, getRun } from '../../runs/store.js';

export interface VisualClaimReviewDependencies {
  authorizeEvidenceAttestation?: () => EvidenceAttestationApprover;
  source?: typeof readVisualReviewSource;
}

export async function runReviewVisualClaim(
  params: RunReviewVisualClaimParams,
  emit: (event: string, payload: unknown) => void,
  dependencies: VisualClaimReviewDependencies = {},
): Promise<RunReviewVisualClaimResult> {
  if (!dependencies.authorizeEvidenceAttestation)
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'A credential-backed person must record visual review.',
    );
  const authorize = dependencies.authorizeEvidenceAttestation;
  const approver = authorize();
  const reason = params.reason?.trim();
  if (!reason || !['confirmed', 'rejected'].includes(params.verdict))
    throw new Error('Visual review requires confirmed/rejected and a written reason.');
  if ('actor' in params || 'judgedAt' in params || 'moments' in params || 'approver' in params)
    throw new Error('Person, time and reviewed moments are gateway-owned.');
  const claimId = normalizeRecipeClaimId(params.claimId);
  const run = getRun(params.runId);
  if (!run || run.readOnly) throw new Error('The retained run is unavailable or read-only.');
  const read = dependencies.source ?? readVisualReviewSource;
  const source = await read(run, params.decisionId);
  const matchingSources = source.sources.filter(
    ({ input }) => input.claims?.recipeRunId === params.recipeRunId,
  );
  if (matchingSources.length !== 1)
    throw new Error('Select one execution from the captured evidence.');
  const input = matchingSources[0]!.input;
  if (validateRecordedEvidencePackage(input).status !== 'valid')
    throw new Error('The selected recorded evidence failed integrity validation.');
  const claim = deriveReviewedRecipeClaims(input).find(({ id }) => id === claimId);
  if (
    !claim ||
    claim.verdict !== 'awaiting-review' ||
    !['visual', 'mixed'].includes(claim.proofMode) ||
    !claim.assertionIndices.length
  )
    throw new Error(
      'Only an eligible visual expectation with passing assertions can be reviewed. Review derived parent checks individually.',
    );
  const closureIdentity = recordedEvidenceClosureIdentity(input);
  const proposal = {
    id: randomUUID(),
    runId: run.id,
    decisionId: source.decisionId,
    snapshotIdentity: source.snapshotIdentity,
    closureIdentity,
    claimId: claim.id,
    recipeRunId: params.recipeRunId,
    verdict: params.verdict,
    moments: claim.moments,
    approver,
    reason,
    judgedAt: new Date().toISOString(),
  };
  const projected = deriveReviewedRecipeClaims(input, {
    runId: run.id,
    recipeRunId: params.recipeRunId,
    closureIdentity,
    receipts: [...(run.visualJudgmentReceipts ?? []), proposal],
  }).find(({ id }) => id === claim.id);
  if (projected?.verdict !== (params.verdict === 'confirmed' ? 'proven' : 'failed'))
    throw new Error('Review derived parent checks individually.');
  const cached = (current: Run) =>
    current.visualJudgmentReceipts?.find(
      (receipt) =>
        receipt.runId === current.id &&
        receipt.recipeRunId === params.recipeRunId &&
        receipt.claimId === claim.id &&
        receipt.closureIdentity === closureIdentity &&
        receipt.verdict === params.verdict &&
        receipt.reason === reason &&
        receipt.approver.principalId === approver.principalId,
    );
  const checked = await read(run, params.decisionId);
  const checkedInput = checked.sources.find(
    ({ input: value }) => value.claims?.recipeRunId === params.recipeRunId,
  )?.input;
  if (
    !checkedInput ||
    validateRecordedEvidencePackage(checkedInput).status !== 'valid' ||
    recordedEvidenceClosureIdentity(checkedInput) !== closureIdentity ||
    source.snapshotIdentity !== checked.snapshotIdentity
  )
    throw new Error('The selected visual evidence changed during review.');
  const assertCurrent = (current: Run) => {
    const person = authorize();
    if (
      getRun(current.id) !== current ||
      current.readOnly ||
      person.principalId !== approver.principalId ||
      person.credentialId !== approver.credentialId
    )
      throw new Error('The authenticated visual review identity changed.');
    if (visualReviewSnapshotIdentity(current, params.decisionId) !== checked.snapshotIdentity)
      throw new Error('The captured visual review selection changed.');
    if (!cached(current) && params.snapshotIdentity !== checked.snapshotIdentity)
      throw new Error('The displayed visual review snapshot changed. Refresh before reviewing.');
  };
  assertCurrent(run);
  const receipt = await commitRunVisualJudgment(
    run.id,
    (current) => cached(current) ?? proposal,
    assertCurrent,
    (snapshot) =>
      appliedVisualJudgmentReceiptIds(
        snapshot,
        source.sources.map(({ input: value }) => value),
      ),
  );
  const updated = getRun(run.id)!;
  emit(Events.RUN_UPDATED, { run: updated });
  return { run: updated, receipt };
}
