import type { AcceptanceCriterionStatus, AcceptanceVerdict } from '../contracts/acceptance.js';
import type { EvidenceAttestationApprover } from '../contracts/run-gate-readiness.js';
import type { RunDecision } from '../contracts/runs.js';

import { digestRecipeDocument } from './digest.js';
import type { RecipeClaimEvidence, RecordedEvidencePackageInput } from './evidence.js';

export const MARK_CLAIM_UNTESTABLE_ACTION = 'mark-untestable';

export function runClaimOverrideSnapshotIdentity(decision: Pick<RunDecision, 'payload'>): string {
  const payload = decision.payload;
  if (payload?.kind === 'ready' && payload.prPackage) return payload.prPackage.packageHash;
  if (payload?.kind === 'output-review')
    return digestRecipeDocument({
      manifestDigest: payload.manifestDigest,
      receipts: payload.claimOverrideReceiptIds ?? [],
      ...(payload.visualJudgmentReceiptIds?.length
        ? { visualJudgments: payload.visualJudgmentReceiptIds }
        : {}),
    });
  throw new TypeError('A frozen ready or output-review snapshot is required.');
}

/** Human exception owned by the gateway Run store, never by a recipe or task file. */
export interface ClaimUntestableOverrideReceipt {
  id: string;
  runId: string;
  decisionId: string;
  claimId: string;
  recipeRunId: string;
  closureIdentity: string;
  priorVerdict: AcceptanceVerdict;
  approver: EvidenceAttestationApprover;
  reason: string;
  overriddenAt: string;
}

/** Callers establish trust by loading receipts from the gateway store and checking actual bytes. */
export interface ClaimOverrideAuthority {
  runId: string;
  recipeRunId: string;
  closureIdentity: string;
  receipts: readonly ClaimUntestableOverrideReceipt[];
}

export function recordedEvidenceClosureIdentity(input: RecordedEvidencePackageInput): string {
  const recipeRunId = input.claims?.recipeRunId;
  if (!recipeRunId) throw new TypeError('A recorded execution identity is required.');
  const files = [...(input.artifactPaths ?? Object.keys(input.artifactDigests))]
    .sort()
    .map((file) => {
      const digest = input.artifactDigests[file];
      if (!/^sha256:[a-f0-9]{64}$/u.test(digest ?? ''))
        throw new TypeError(`A checked byte digest is required for ${file}.`);
      return [file, digest];
    });
  return digestRecipeDocument({ recipeRunId, files });
}

function receiptChain(claimId: string, authority: ClaimOverrideAuthority) {
  return authority.receipts.filter(
    (receipt) =>
      receipt.runId === authority.runId &&
      receipt.claimId === claimId &&
      receipt.recipeRunId === authority.recipeRunId &&
      receipt.closureIdentity === authority.closureIdentity,
  );
}

/** Same predicate for satisfaction and binding. A task-file actor string is never authority. */
export function isAuthorizedOverride(
  row: AcceptanceCriterionStatus,
  engineClaim: RecipeClaimEvidence,
  authority: ClaimOverrideAuthority,
): boolean {
  if (row.verdict !== 'untestable' || row.id !== engineClaim.id || row.text !== engineClaim.text)
    return false;
  const chain = receiptChain(engineClaim.id, authority);
  if (!chain.length || row.overrides?.length !== chain.length) return false;
  const seen = new Set<string>();
  return chain.every((receipt, index) => {
    if (seen.has(receipt.id)) return false;
    seen.add(receipt.id);
    return (
      row.overrides?.[index]?.receiptId === receipt.id &&
      Boolean(receipt.id.trim()) &&
      Boolean(receipt.approver.principalId.trim()) &&
      Boolean(receipt.approver.credentialId.trim()) &&
      Boolean(receipt.reason.trim()) &&
      Number.isFinite(Date.parse(receipt.overriddenAt)) &&
      receipt.priorVerdict === (index === 0 ? engineClaim.verdict : 'untestable')
    );
  });
}

/** Derived presentation only; the engine claim and its artifact bytes remain unchanged. */
export function projectClaimUntestableOverride(
  engineClaim: RecipeClaimEvidence,
  authority: ClaimOverrideAuthority,
): AcceptanceCriterionStatus {
  const chain = receiptChain(engineClaim.id, authority);
  const row: AcceptanceCriterionStatus = {
    ...engineClaim,
    verdict: 'untestable',
    engineVerdict: engineClaim.verdict,
    overrides: chain.map(({ id }) => ({ receiptId: id })),
    note: chain.at(-1)?.reason,
  };
  return isAuthorizedOverride(row, engineClaim, authority) ? row : engineClaim;
}
