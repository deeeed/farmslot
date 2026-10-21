import {
  type EvidenceAttestationApprover,
  isEvidenceAttestationApprover,
} from '../contracts/run-gate-readiness.js';

import { recordedEvidenceClosureIdentity } from './claim-overrides.js';
import { isRecord } from './common.js';
import { digestRecipeDocument } from './digest.js';
import { type RecipeVisualJudgment, type RecordedEvidencePackageInput } from './evidence.js';

export const CONFIRM_VISUAL_CLAIM_ACTION = 'confirm-visual';
export const REJECT_VISUAL_CLAIM_ACTION = 'reject-visual';

export type RecipeVisualJudgmentKind =
  | 'person-reviewed'
  | 'lead-agent-reviewed'
  | 'pipeline-reviewed';

/** Undefined kind is unqualified embedded input, which always needs rationale. */
export function validVisualJudgmentReason(
  kind: RecipeVisualJudgmentKind | undefined,
  verdict: RecipeVisualJudgment['verdict'],
  reason?: string,
): boolean {
  return Boolean(reason?.trim()) || (kind === 'person-reviewed' && verdict === 'confirmed');
}

export interface ProjectVisualClaimReviewPolicy {
  delegatedReviewerPrincipalIds?: string[];
  delegatorPrincipalId?: string;
  /** Identity generation the delegator must hold. Omission means zero. */
  delegatorPrincipalGeneration?: number;
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
    ((value.delegatorPrincipalId !== undefined ||
      value.delegatedReviewerPrincipalIds !== undefined) &&
      (typeof value.delegatorPrincipalId !== 'string' ||
        !value.delegatorPrincipalId.trim() ||
        !Array.isArray(value.delegatedReviewerPrincipalIds) ||
        value.delegatedReviewerPrincipalIds.some((id) => typeof id !== 'string' || !id.trim()))) ||
    (value.delegatorPrincipalGeneration !== undefined &&
      (value.delegatorPrincipalId === undefined ||
        typeof value.delegatorPrincipalGeneration !== 'number' ||
        !Number.isSafeInteger(value.delegatorPrincipalGeneration) ||
        value.delegatorPrincipalGeneration < 1)) ||
    Object.keys(value).some(
      (key) =>
        ![
          'delegatedReviewerPrincipalIds',
          'delegatorPrincipalId',
          'delegatorPrincipalGeneration',
        ].includes(key),
    )
  )
    throw new TypeError('Invalid project visualClaimReview policy.');
  return {
    ...(typeof value.delegatorPrincipalId === 'string'
      ? {
          delegatorPrincipalId: value.delegatorPrincipalId,
          ...(typeof value.delegatorPrincipalGeneration === 'number'
            ? { delegatorPrincipalGeneration: value.delegatorPrincipalGeneration }
            : {}),
          delegatedReviewerPrincipalIds: [
            ...new Set(value.delegatedReviewerPrincipalIds as string[]),
          ].sort(),
        }
      : {}),
  };
}

export function delegatedVisualClaimAllowed(
  reviewerPrincipalId: string,
  policy: ProjectVisualClaimReviewPolicy | undefined,
): boolean {
  return Boolean(policy?.delegatedReviewerPrincipalIds?.includes(reviewerPrincipalId));
}

export interface PipelineVisualReviewerBinding {
  contextId: string;
  executionNodeId: string;
  ownerPrincipalId: string;
  sessionId: string;
  generation: string;
  leaseId: string;
  commandId: string;
}

export type RecipeVisualReviewerIdentity =
  | EvidenceAttestationApprover
  | {
      principalId: string;
      displayName: string;
      credentialId?: never;
      personSessionId?: never;
    };

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
  approver: RecipeVisualReviewerIdentity;
  /** Absence identifies the already-shipped credential-backed person receipts. */
  kind?: RecipeVisualJudgmentKind;
  reviewerSubjectKind?: RecipeVisualReviewer['subjectKind'];
  reviewedFiles?: { path: string; digest: string }[];
  delegation?: { principalId: string; displayName: string; policyDigest: string };
  /** Internal pipeline collection only; manual judgment RPC cannot supply this binding. */
  pipeline?: PipelineVisualReviewerBinding;
  /** New captures retain the same winner in current and frozen projections. */
  precedence?: 'person-first-v1';
  /** Gateway-qualified evidence findings settled by this person's claim decision. */
  settledReviewFindings?: ReviewFindingReference[];
}

export interface ReviewFindingReference {
  findingId: string;
  reviewId: string;
  headSha: string;
}

/** A projection keeps its original verdict and points back to the person receipt. */
export interface ReviewFindingSettlement extends ReviewFindingReference {
  receiptId: string;
  claimId: string;
}

/**
 * Gateway review authority for one execution: stored visual receipts and the code-review
 * fact. Consumers load it from the gateway, never from a recipe/task file.
 */
export interface RecipeVisualReviewAuthority {
  runId: string;
  recipeRunId: string;
  closureIdentity: string;
  receipts: readonly RecipeVisualJudgmentReceipt[];
  projectPolicy?: ProjectVisualClaimReviewPolicy;
  /** Read-only frozen projection retains the policy qualification recorded by its receipts. */
  historical?: boolean;
  /**
   * The gate's publication-review prerequisite is met at the package head, so `review`
   * claims are proven (ADR-062 Amendment 18). Only the gateway computes it.
   */
  codeReviewCertified?: boolean;
}

export interface QualifiedRecipeVisualJudgment extends Omit<RecipeVisualJudgment, 'reason'> {
  reason?: string;
  receiptId: string;
  kind: RecipeVisualJudgmentKind;
  reviewer: RecipeVisualReviewerIdentity;
  delegation?: RecipeVisualJudgmentReceipt['delegation'];
  pipeline?: PipelineVisualReviewerBinding;
}

/** Current projections put the latest person after agents so a person Issue cannot be cleared by an agent. */
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
  const qualified = authority.receipts.flatMap((receipt): QualifiedRecipeVisualJudgment[] => {
    const claim = input.claims!.criteria.find(({ id }) => id === receipt.claimId);
    const kind = receipt.kind ?? 'person-reviewed';
    const delegated = kind === 'lead-agent-reviewed';
    const pipeline = kind === 'pipeline-reviewed';
    if (
      !claim ||
      !['visual', 'mixed'].includes(claim.proofMode) ||
      receipt.runId !== authority.runId ||
      receipt.recipeRunId !== authority.recipeRunId ||
      receipt.closureIdentity !== authority.closureIdentity ||
      !receipt.id?.trim() ||
      (pipeline
        ? !receipt.approver?.displayName?.trim() ||
          receipt.approver.credentialId !== undefined ||
          receipt.approver.personSessionId !== undefined ||
          receipt.approver.principalId !==
            `native-review:${receipt.pipeline?.sessionId}:${receipt.pipeline?.leaseId}`
        : !isEvidenceAttestationApprover(receipt.approver)) ||
      !validVisualJudgmentReason(kind, receipt.verdict, receipt.reason) ||
      !['confirmed', 'rejected'].includes(receipt.verdict) ||
      !Number.isFinite(Date.parse(receipt.judgedAt)) ||
      digestRecipeDocument(receipt.moments) !== digestRecipeDocument(claim.moments) ||
      !['person-reviewed', 'lead-agent-reviewed', 'pipeline-reviewed'].includes(kind) ||
      (receipt.kind !== undefined &&
        receipt.reviewerSubjectKind !== (kind === 'person-reviewed' ? 'person' : 'service')) ||
      (receipt.reviewedFiles !== undefined &&
        digestRecipeDocument(receipt.reviewedFiles) !==
          digestRecipeDocument(reviewedVisualFiles(input, receipt.claimId))) ||
      (pipeline &&
        (!receipt.pipeline ||
          Object.values(receipt.pipeline).some(
            (value) => typeof value !== 'string' || !value.trim(),
          ) ||
          ![
            'contextId',
            'executionNodeId',
            'ownerPrincipalId',
            'sessionId',
            'generation',
            'leaseId',
            'commandId',
          ].every((key) =>
            Boolean(receipt.pipeline?.[key as keyof PipelineVisualReviewerBinding]),
          ) ||
          !receipt.reviewedFiles?.length)) ||
      (delegated &&
        (!receipt.approver.credentialId ||
          !receipt.reviewedFiles?.length ||
          !receipt.delegation?.principalId.trim() ||
          !receipt.delegation?.displayName.trim() ||
          !/^sha256:[a-f0-9]{64}$/u.test(receipt.delegation.policyDigest) ||
          (!authority.historical &&
            (!delegatedVisualClaimAllowed(receipt.approver.principalId, authority.projectPolicy) ||
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
        ...(receipt.pipeline ? { pipeline: receipt.pipeline } : {}),
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
  const currentPrecedence = authority.receipts.some(
    (receipt) =>
      (receipt.precedence === 'person-first-v1' || receipt.kind === 'pipeline-reviewed') &&
      qualified.some((judgment) => judgment.receiptId === receipt.id),
  );
  return authority.historical && !currentPrecedence
    ? qualified
    : qualified.sort(
        (a, b) =>
          Number(a.kind === 'person-reviewed') - Number(b.kind === 'person-reviewed') ||
          Date.parse(a.judgedAt) - Date.parse(b.judgedAt),
      );
}
