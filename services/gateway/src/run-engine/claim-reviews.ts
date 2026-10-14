import { deriveReviewedRecipeClaims } from '@farmslot/adapter-sdk/evidence';
import {
  type RecipeVisualReviewAuthority,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
  recordedVisualJudgments,
  type Run,
} from '@farmslot/protocol';

export function visualReviewAuthority(
  run: Run,
  input: RecordedEvidencePackageInput,
  capturedIds?: readonly string[],
): RecipeVisualReviewAuthority {
  return {
    runId: run.id,
    recipeRunId: input.claims!.recipeRunId,
    closureIdentity: recordedEvidenceClosureIdentity(input),
    receipts: (run.visualJudgmentReceipts ?? []).filter(
      (receipt) => capturedIds === undefined || capturedIds.includes(receipt.id),
    ),
  };
}

export function reviewedRecipeClaims(run: Run, input: RecordedEvidencePackageInput) {
  return deriveReviewedRecipeClaims(input, visualReviewAuthority(run, input));
}

export function appliedVisualJudgmentReceiptIds(
  run: Run,
  inputs: readonly RecordedEvidencePackageInput[],
): string[] {
  return [
    ...new Set(
      inputs.flatMap((input) =>
        input.claims
          ? recordedVisualJudgments(input, visualReviewAuthority(run, input)).map(
              ({ receiptId }) => receiptId,
            )
          : [],
      ),
    ),
  ].sort();
}
