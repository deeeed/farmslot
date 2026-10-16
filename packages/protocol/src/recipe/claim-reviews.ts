import {
  type EvidenceAttestationApprover,
  isEvidenceAttestationApprover,
} from '../contracts/run-gate-readiness.js';

import { recordedEvidenceClosureIdentity } from './claim-overrides.js';
import { isRecord } from './common.js';
import { digestRecipeDocument } from './digest.js';
import {
  normalizeRecipeClaimId,
  type RecipeVisualJudgment,
  type RecordedEvidencePackageInput,
} from './evidence.js';

export const CONFIRM_VISUAL_CLAIM_ACTION = 'confirm-visual';
export const REJECT_VISUAL_CLAIM_ACTION = 'reject-visual';

export type RecipeVisualJudgmentKind = 'person-reviewed' | 'lead-agent-reviewed';

/** Undefined kind is unqualified embedded input, which always needs rationale. */
export function validVisualJudgmentReason(
  kind: RecipeVisualJudgmentKind | undefined,
  verdict: RecipeVisualJudgment['verdict'],
  reason?: string,
): boolean {
  return Boolean(reason?.trim()) || (kind === 'person-reviewed' && verdict === 'confirmed');
}

export interface ProjectVisualClaimReviewPolicy {
  delegatedReviewerPrincipalIds: string[];
  delegatorPrincipalId: string;
  personOnlyClaimIds?: string[];
}

export type RecipeVisualReviewer = EvidenceAttestationApprover & {
  subjectKind: 'person' | 'service';
  delegator?: Pick<EvidenceAttestationApprover, 'principalId' | 'displayName'>;
};

/** Operator-owned project policy, never supplied by a task or judgment request. */
export function parseProjectVisualClaimReviewPolicy(
  value: unknown,
): ProjectVisualClaimReviewPolicy | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.delegatorPrincipalId !== 'string' ||
    !value.delegatorPrincipalId.trim() ||
    !Array.isArray(value.delegatedReviewerPrincipalIds) ||
    value.delegatedReviewerPrincipalIds.some((id) => typeof id !== 'string' || !id.trim()) ||
    (value.personOnlyClaimIds !== undefined &&
      (!Array.isArray(value.personOnlyClaimIds) ||
        value.personOnlyClaimIds.some((id) => typeof id !== 'string' || !id.trim()))) ||
    Object.keys(value).some(
      (key) =>
        !['delegatedReviewerPrincipalIds', 'delegatorPrincipalId', 'personOnlyClaimIds'].includes(
          key,
        ),
    )
  )
    throw new TypeError('Invalid project visualClaimReview policy.');
  return {
    delegatorPrincipalId: value.delegatorPrincipalId,
    delegatedReviewerPrincipalIds: [
      ...new Set(value.delegatedReviewerPrincipalIds as string[]),
    ].sort(),
    ...(value.personOnlyClaimIds
      ? {
          personOnlyClaimIds: [
            ...new Set((value.personOnlyClaimIds as string[]).map(normalizeRecipeClaimId)),
          ].sort(),
        }
      : {}),
  };
}

export function delegatedVisualClaimAllowed(
  input: RecordedEvidencePackageInput,
  claimId: string,
  reviewerPrincipalId: string,
  policy: ProjectVisualClaimReviewPolicy | undefined,
): boolean {
  if (!policy?.delegatedReviewerPrincipalIds.includes(reviewerPrincipalId)) return false;
  const personOnly = new Set(policy.personOnlyClaimIds ?? []);
  let claim = input.claims?.criteria.find(({ id }) => id === normalizeRecipeClaimId(claimId));
  if (!claim) return false;
  while (claim) {
    if (personOnly.has(claim.id)) return false;
    claim = input.claims?.criteria.find(({ id }) => id === claim!.parentId);
  }
  return true;
}

export function reviewedVisualFiles(
  input: RecordedEvidencePackageInput,
  claimId: string,
): { path: string; digest: string }[] {
  const claim = input.claims?.criteria.find(({ id }) => id === claimId);
  return [...new Set(claim?.evidence ?? [])]
    .filter((file) => /\.(?:png|jpe?g|webp|gif|mp4|mov|webm)$/iu.test(file))
    .sort()
    .map((path) => ({ path, digest: input.artifactDigests[path]! }));
}

/** The gateway owns reviewer identity and time; the engine owns the reviewed moments. */
export interface RecipeVisualJudgmentReceipt extends Omit<
  RecipeVisualJudgment,
  'actor' | 'reason'
> {
  reason?: string;
  id: string;
  runId: string;
  decisionId?: string;
  snapshotIdentity: string;
  closureIdentity: string;
  approver: EvidenceAttestationApprover;
  /** Absence identifies the already-shipped credential-backed person receipts. */
  kind?: RecipeVisualJudgmentKind;
  reviewerSubjectKind?: RecipeVisualReviewer['subjectKind'];
  reviewedFiles?: { path: string; digest: string }[];
  delegation?: { principalId: string; displayName: string; policyDigest: string };
}

/** Consumers load receipts from the gateway store, never from a recipe/task file. */
export interface RecipeVisualReviewAuthority {
  runId: string;
  recipeRunId: string;
  closureIdentity: string;
  receipts: readonly RecipeVisualJudgmentReceipt[];
  projectPolicy?: ProjectVisualClaimReviewPolicy;
  /** Read-only frozen projection retains the policy qualification recorded by its receipts. */
  historical?: boolean;
}

export interface QualifiedRecipeVisualJudgment extends Omit<RecipeVisualJudgment, 'reason'> {
  reason?: string;
  receiptId: string;
  kind: RecipeVisualJudgmentKind;
  reviewer: EvidenceAttestationApprover;
  delegation?: RecipeVisualJudgmentReceipt['delegation'];
}

/** Keep stored order so the engine's existing last-judgment rule applies. */
export function recordedVisualJudgments(
  input: RecordedEvidencePackageInput,
  authority: RecipeVisualReviewAuthority,
): QualifiedRecipeVisualJudgment[] {
  if (
    !input.claims ||
    authority.recipeRunId !== input.claims.recipeRunId ||
    authority.closureIdentity !== recordedEvidenceClosureIdentity(input)
  )
    return [];
  return authority.receipts.flatMap((receipt) => {
    const claim = input.claims!.criteria.find(({ id }) => id === receipt.claimId);
    const kind = receipt.kind ?? 'person-reviewed';
    const delegated = kind === 'lead-agent-reviewed';
    if (
      !claim ||
      !['visual', 'mixed'].includes(claim.proofMode) ||
      receipt.runId !== authority.runId ||
      receipt.recipeRunId !== authority.recipeRunId ||
      receipt.closureIdentity !== authority.closureIdentity ||
      !receipt.id?.trim() ||
      !isEvidenceAttestationApprover(receipt.approver) ||
      !validVisualJudgmentReason(kind, receipt.verdict, receipt.reason) ||
      !['confirmed', 'rejected'].includes(receipt.verdict) ||
      !Number.isFinite(Date.parse(receipt.judgedAt)) ||
      digestRecipeDocument(receipt.moments) !== digestRecipeDocument(claim.moments) ||
      !['person-reviewed', 'lead-agent-reviewed'].includes(kind) ||
      (receipt.kind !== undefined &&
        receipt.reviewerSubjectKind !== (delegated ? 'service' : 'person')) ||
      (receipt.reviewedFiles !== undefined &&
        digestRecipeDocument(receipt.reviewedFiles) !==
          digestRecipeDocument(reviewedVisualFiles(input, receipt.claimId))) ||
      (delegated &&
        (!receipt.approver.credentialId ||
          !receipt.reviewedFiles?.length ||
          !receipt.delegation?.principalId.trim() ||
          !receipt.delegation?.displayName.trim() ||
          !/^sha256:[a-f0-9]{64}$/u.test(receipt.delegation.policyDigest) ||
          (!authority.historical &&
            (!delegatedVisualClaimAllowed(
              input,
              receipt.claimId,
              receipt.approver.principalId,
              authority.projectPolicy,
            ) ||
              receipt.delegation.principalId !== authority.projectPolicy?.delegatorPrincipalId ||
              receipt.delegation.policyDigest !== digestRecipeDocument(authority.projectPolicy)))))
    )
      return [];
    return [
      {
        receiptId: receipt.id,
        kind,
        reviewer: receipt.approver,
        ...(receipt.delegation ? { delegation: receipt.delegation } : {}),
        claimId: receipt.claimId,
        recipeRunId: receipt.recipeRunId,
        verdict: receipt.verdict,
        moments: receipt.moments,
        actor: receipt.approver.principalId,
        ...(receipt.reason !== undefined ? { reason: receipt.reason } : {}),
        judgedAt: receipt.judgedAt,
      },
    ];
  });
}
