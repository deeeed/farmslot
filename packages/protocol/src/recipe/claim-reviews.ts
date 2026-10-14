import type { EvidenceAttestationApprover } from '../contracts/run-gate-readiness.js';

import { recordedEvidenceClosureIdentity } from './claim-overrides.js';
import { digestRecipeDocument } from './digest.js';
import type { RecipeVisualJudgment, RecordedEvidencePackageInput } from './evidence.js';

export const CONFIRM_VISUAL_CLAIM_ACTION = 'confirm-visual';
export const REJECT_VISUAL_CLAIM_ACTION = 'reject-visual';

/** The gateway owns the person and time; the engine owns the reviewed moments. */
export interface RecipeVisualJudgmentReceipt extends Omit<RecipeVisualJudgment, 'actor'> {
  id: string;
  runId: string;
  decisionId?: string;
  snapshotIdentity: string;
  closureIdentity: string;
  approver: EvidenceAttestationApprover;
}

/** Consumers load receipts from the gateway store, never from a recipe/task file. */
export interface RecipeVisualReviewAuthority {
  runId: string;
  recipeRunId: string;
  closureIdentity: string;
  receipts: readonly RecipeVisualJudgmentReceipt[];
}

export interface QualifiedRecipeVisualJudgment extends RecipeVisualJudgment {
  receiptId: string;
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
    if (
      !claim ||
      !['visual', 'mixed'].includes(claim.proofMode) ||
      receipt.runId !== authority.runId ||
      receipt.recipeRunId !== authority.recipeRunId ||
      receipt.closureIdentity !== authority.closureIdentity ||
      !receipt.id?.trim() ||
      !receipt.approver?.principalId?.trim() ||
      !receipt.approver?.credentialId?.trim() ||
      !receipt.reason?.trim() ||
      !['confirmed', 'rejected'].includes(receipt.verdict) ||
      !Number.isFinite(Date.parse(receipt.judgedAt)) ||
      digestRecipeDocument(receipt.moments) !== digestRecipeDocument(claim.moments)
    )
      return [];
    return [
      {
        receiptId: receipt.id,
        claimId: receipt.claimId,
        recipeRunId: receipt.recipeRunId,
        verdict: receipt.verdict,
        moments: receipt.moments,
        actor: receipt.approver.principalId,
        reason: receipt.reason,
        judgedAt: receipt.judgedAt,
      },
    ];
  });
}
