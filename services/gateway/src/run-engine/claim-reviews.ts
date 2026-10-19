import { deriveReviewedRecipeClaims, recordedClaimSources } from '@farmslot/adapter-sdk/evidence';
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
  historical = false,
  codeReviewCertified = false,
): RecipeVisualReviewAuthority {
  return {
    runId: run.id,
    recipeRunId: input.claims!.recipeRunId,
    closureIdentity: recordedEvidenceClosureIdentity(input),
    ...(historical ? { historical: true } : {}),
    ...(projectPolicy ? { projectPolicy } : {}),
    ...(codeReviewCertified ? { codeReviewCertified: true } : {}),
    receipts: (run.visualJudgmentReceipts ?? []).filter(
      (receipt) => capturedIds === undefined || capturedIds.includes(receipt.id),
    ),
  };
}

/** Each recorded source a validated package selects claims from; a repair may keep originals. */
export function selectedSourceInputs(
  input: RecordedEvidencePackageInput,
): Array<{ input: RecordedEvidencePackageInput; claimIds: Set<string> }> {
  const groups = new Map<RecordedEvidencePackageInput, Set<string>>();
  for (const source of recordedClaimSources(input)) {
    const claims = groups.get(source.input) ?? new Set<string>();
    claims.add(source.claimId);
    groups.set(source.input, claims);
  }
  return [...groups].map(([source, claimIds]) => ({ input: source, claimIds }));
}

/** The recorded source whose closure qualifies receipts for one selected claim. */
export function claimSourceInput(
  input: RecordedEvidencePackageInput,
  claimId: string,
): RecordedEvidencePackageInput | undefined {
  return recordedClaimSources(input).find((source) => source.claimId === claimId)?.input;
}

export interface VisualReviewReadSelection {
  capturedIds?: readonly string[];
  historical?: boolean;
  /** Computed by gate readiness for the package head; never read from a task file. */
  codeReviewCertified?: boolean;
}

export function reviewedRecipeClaims(
  run: Run,
  input: RecordedEvidencePackageInput,
  policy?: ProjectVisualClaimReviewPolicy,
  selection: VisualReviewReadSelection = {},
) {
  return deriveReviewedRecipeClaims(
    input,
    visualReviewAuthority(
      run,
      input,
      selection.capturedIds,
      policy,
      selection.historical,
      selection.codeReviewCertified,
    ),
  );
}

export function appliedVisualJudgmentReceiptIds(
  run: Run,
  inputs: readonly RecordedEvidencePackageInput[],
  policy?: ProjectVisualClaimReviewPolicy,
  selection: VisualReviewReadSelection = {},
): string[] {
  return [
    ...new Set(
      inputs.flatMap((input) =>
        input.claims
          ? selectedSourceInputs(input).flatMap((source) =>
              recordedVisualJudgments(
                source.input,
                visualReviewAuthority(
                  run,
                  source.input,
                  selection.capturedIds,
                  policy,
                  selection.historical,
                ),
              )
                .filter(({ claimId }) => source.claimIds.has(claimId))
                .map(({ receiptId }) => receiptId),
            )
          : [],
      ),
    ),
  ].sort();
}
