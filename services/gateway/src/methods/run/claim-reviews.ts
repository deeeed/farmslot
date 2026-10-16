import { randomUUID } from 'node:crypto';

import {
  deriveReviewedRecipeClaims,
  validateRecordedEvidencePackage,
} from '@farmslot/adapter-sdk/evidence';
import {
  delegatedVisualClaimAllowed,
  digestRecipeDocument,
  Events,
  normalizeRecipeClaimId,
  type ProjectVisualClaimReviewPolicy,
  type RecipeVisualJudgmentKind,
  type RecipeVisualReviewer,
  recordedEvidenceClosureIdentity,
  reviewedVisualFiles,
  type Run,
  type RunRefreshPublishPackageParams,
  type RunReviewVisualClaimParams,
  type RunReviewVisualClaimResult,
  sameEvidenceAttestationApprover,
  validVisualJudgmentReason,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../../core/method-error.js';
import {
  appliedVisualJudgmentReceiptIds,
  readVisualReviewPolicy,
} from '../../run-engine/claim-reviews.js';
import { refreshPublishPackage } from '../../run-engine/publish-package-refresh.js';
import {
  readVisualReviewSource,
  visualReviewSnapshotIdentity,
} from '../../run-engine/recorded-evidence-sources.js';
import { commitRunVisualJudgment, getRun } from '../../runs/store.js';

export interface VisualClaimReviewDependencies {
  authorizeVisualClaimReview?: (
    kind: RecipeVisualJudgmentKind,
    policy?: ProjectVisualClaimReviewPolicy,
  ) => RecipeVisualReviewer;
  policy?: typeof readVisualReviewPolicy;
  source?: typeof readVisualReviewSource;
  refreshPackage?: (params: RunRefreshPublishPackageParams) => Promise<{ run: Run }>;
}

export async function runReviewVisualClaim(
  params: RunReviewVisualClaimParams,
  emit: (event: string, payload: unknown) => void,
  dependencies: VisualClaimReviewDependencies = {},
): Promise<RunReviewVisualClaimResult> {
  if (!dependencies.authorizeVisualClaimReview)
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'A credential-backed person or delegated service must record visual review.',
    );
  const authorize = dependencies.authorizeVisualClaimReview;
  const kind = params.kind ?? 'person-reviewed';
  if (!['person-reviewed', 'lead-agent-reviewed'].includes(kind))
    throw new Error('Unknown visual judgment kind.');
  const delegated = kind === 'lead-agent-reviewed';
  const reason = params.reason?.trim();
  if (
    !['confirmed', 'rejected'].includes(params.verdict) ||
    !validVisualJudgmentReason(kind, params.verdict, reason)
  )
    throw new Error('Rejections and delegated visual reviews require a written reason.');
  if (
    [
      'actor',
      'judgedAt',
      'moments',
      'approver',
      'reviewerSubjectKind',
      'reviewedFiles',
      'delegation',
      'projectPolicy',
    ].some((key) => key in params)
  )
    throw new Error('Reviewer, time, delegation and reviewed evidence are gateway-owned.');
  const claimId = normalizeRecipeClaimId(params.claimId);
  const run = getRun(params.runId);
  if (!run || run.readOnly) throw new Error('The retained run is unavailable or read-only.');
  const readPolicy = dependencies.policy ?? readVisualReviewPolicy;
  const policy = delegated ? await readPolicy(run) : undefined;
  const reviewer = authorize(kind, policy);
  if (reviewer.subjectKind !== (delegated ? 'service' : 'person'))
    throw new Error('The reviewer identity does not match the judgment kind.');
  const { subjectKind, delegator, ...approver } = reviewer;
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
  if (delegated && (!delegator || !delegatedVisualClaimAllowed(approver.principalId, policy)))
    throw new Error('This reviewer has no matching project delegation.');
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
    kind,
    precedence: 'person-first-v1' as const,
    reviewerSubjectKind: subjectKind,
    reviewedFiles: reviewedVisualFiles(input, claim.id),
    ...(delegated && delegator
      ? { delegation: { ...delegator, policyDigest: digestRecipeDocument(policy) } }
      : {}),
    ...(reason ? { reason } : {}),
    judgedAt: new Date().toISOString(),
  };
  const projected = deriveReviewedRecipeClaims(input, {
    runId: run.id,
    recipeRunId: params.recipeRunId,
    closureIdentity,
    receipts: [...(run.visualJudgmentReceipts ?? []), proposal],
    ...(policy ? { projectPolicy: policy } : {}),
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
        receipt.snapshotIdentity === params.snapshotIdentity &&
        receipt.verdict === params.verdict &&
        receipt.reason === reason &&
        (receipt.kind ?? 'person-reviewed') === kind &&
        digestRecipeDocument(receipt.delegation ?? null) ===
          digestRecipeDocument(proposal.delegation ?? null) &&
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
  const assertCurrent = async (current: Run) => {
    const currentPolicy = delegated ? await readPolicy(current) : undefined;
    const person = authorize(kind, currentPolicy);
    if (
      getRun(current.id) !== current ||
      current.readOnly ||
      !sameEvidenceAttestationApprover(person, approver) ||
      person.subjectKind !== subjectKind ||
      digestRecipeDocument(currentPolicy ?? null) !== digestRecipeDocument(policy ?? null) ||
      digestRecipeDocument(person.delegator ?? null) !== digestRecipeDocument(delegator ?? null)
    )
      throw new Error('The authenticated visual review identity changed.');
    if (visualReviewSnapshotIdentity(current, params.decisionId) !== checked.snapshotIdentity)
      throw new Error('The captured visual review selection changed.');
    if (!cached(current) && params.snapshotIdentity !== checked.snapshotIdentity)
      throw new Error('The displayed visual review snapshot changed. Refresh before reviewing.');
  };
  await assertCurrent(run);
  const receipt = await commitRunVisualJudgment(
    run.id,
    (current) => cached(current) ?? proposal,
    assertCurrent,
    (snapshot) =>
      appliedVisualJudgmentReceiptIds(
        snapshot,
        source.sources.map(({ input: value }) => value),
        policy,
      ),
  );
  let updated = getRun(run.id)!;
  emit(Events.RUN_UPDATED, { run: updated });
  if (
    source.decisionId &&
    updated.decisions.some(
      (decision) =>
        decision.id === source.decisionId &&
        !decision.resolvedAt &&
        decision.payload?.kind === 'ready',
    )
  ) {
    try {
      const refreshed = await (dependencies.refreshPackage ?? refreshPublishPackage)({
        runId: run.id,
        decisionId: source.decisionId,
      });
      updated = refreshed.run;
    } catch (error) {
      // The judgment is durable. Its idempotent retry can repeat the supported
      // refresh without creating another receipt or losing the person's decision.
      throw new GatewayMethodError(
        'VISUAL_JUDGMENT_REFRESH_REQUIRED',
        `Judgment saved, but package refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          userAction: 'Retry the judgment or refresh the publication package.',
          details: { runId: run.id, receiptId: receipt.id },
        },
      );
    }
    emit(Events.RUN_UPDATED, { run: updated });
  }
  return { run: updated, receipt };
}
