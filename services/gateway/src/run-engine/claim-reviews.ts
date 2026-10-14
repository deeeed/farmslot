import { deriveReviewedRecipeClaims } from '@farmslot/adapter-sdk/evidence';
import {
  type ProjectVisualClaimReviewPolicy,
  type RecipeVisualReviewAuthority,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
  recordedVisualJudgments,
  type Run,
} from '@farmslot/protocol';

import { loadProjectConfig } from '../fleet/state.js';

export async function readVisualReviewPolicy(
  run: Run,
): Promise<ProjectVisualClaimReviewPolicy | undefined> {
  return (await loadProjectConfig(run.project))?.visualClaimReview;
}

export function visualReviewAuthority(
  run: Run,
  input: RecordedEvidencePackageInput,
  capturedIds?: readonly string[],
  projectPolicy?: ProjectVisualClaimReviewPolicy,
): RecipeVisualReviewAuthority {
  return {
    runId: run.id,
    recipeRunId: input.claims!.recipeRunId,
    closureIdentity: recordedEvidenceClosureIdentity(input),
    ...(projectPolicy ? { projectPolicy } : {}),
    receipts: (run.visualJudgmentReceipts ?? []).filter(
      (receipt) => capturedIds === undefined || capturedIds.includes(receipt.id),
    ),
  };
}

export function reviewedRecipeClaims(
  run: Run,
  input: RecordedEvidencePackageInput,
  policy?: ProjectVisualClaimReviewPolicy,
) {
  return deriveReviewedRecipeClaims(input, visualReviewAuthority(run, input, undefined, policy));
}

export function appliedVisualJudgmentReceiptIds(
  run: Run,
  inputs: readonly RecordedEvidencePackageInput[],
  policy?: ProjectVisualClaimReviewPolicy,
): string[] {
  return [
    ...new Set(
      inputs.flatMap((input) =>
        input.claims
          ? recordedVisualJudgments(
              input,
              visualReviewAuthority(run, input, undefined, policy),
            ).map(({ receiptId }) => receiptId)
          : [],
      ),
    ),
  ].sort();
}
