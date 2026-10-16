import { selectedRecipeClaims } from '@farmslot/adapter-sdk/evidence';
import {
  type ClaimOverrideAuthority,
  projectClaimUntestableOverride,
  type ProjectVisualClaimReviewPolicy,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
  type Run,
} from '@farmslot/protocol';

import {
  claimSourceInput,
  reviewedRecipeClaims,
  selectedSourceInputs,
  type VisualReviewReadSelection,
} from './claim-reviews.js';
import type { GateAcceptanceRead } from './gate-prerequisites.js';

export function claimOverrideAuthority(
  run: Run,
  input: RecordedEvidencePackageInput,
): ClaimOverrideAuthority {
  return {
    runId: run.id,
    recipeRunId: input.claims!.recipeRunId,
    closureIdentity: recordedEvidenceClosureIdentity(input),
    receipts: run.claimOverrideReceipts ?? [],
  };
}

export function appliedClaimOverrideReceiptIds(
  run: Run,
  inputs: readonly RecordedEvidencePackageInput[],
): string[] {
  return [
    ...new Set(
      inputs.flatMap((input) => {
        if (!input.claims) return [];
        return selectedSourceInputs(input).flatMap((source) => {
          const authority = claimOverrideAuthority(run, source.input);
          return source.input
            .claims!.criteria.filter(({ id }) => source.claimIds.has(id))
            .flatMap(
              (claim) =>
                projectClaimUntestableOverride(claim, authority).overrides?.map(
                  ({ receiptId }) => receiptId,
                ) ?? [],
            );
        });
      }),
    ),
  ].sort();
}

/** Task rows transport the selected attempt. Only stored gateway receipts may change their review verdict. */
export function projectGateAcceptance(
  acceptance: GateAcceptanceRead,
  run: Run,
  inputs: readonly RecordedEvidencePackageInput[],
  policy?: ProjectVisualClaimReviewPolicy,
  selection?: VisualReviewReadSelection,
): GateAcceptanceRead {
  if (acceptance.ledger?.schemaVersion !== 2) return acceptance;
  const input = inputs.find(
    (input) => input.claims?.recipeRunId === acceptance.ledger?.recipeRunId,
  );
  if (!input?.claims) return acceptance;
  const reviewed = reviewedRecipeClaims(run, input, policy, selection);
  const selected = selectedRecipeClaims(input);
  return {
    ...acceptance,
    ledger: {
      ...acceptance.ledger,
      criteria: acceptance.ledger.criteria.map((row) => {
        const claim = selected.find(({ id }) => id === row.id);
        if (
          !claim ||
          row.overrides !== undefined ||
          row.verdict !== claim.verdict ||
          row.text !== claim.text
        )
          return row;
        const projected = projectClaimUntestableOverride(
          claim,
          claimOverrideAuthority(run, claimSourceInput(input, row.id) ?? input),
        );
        return projected.verdict === 'untestable'
          ? { ...row, ...projected, evidence: row.evidence }
          : { ...row, ...reviewed.find(({ id }) => id === row.id), evidence: row.evidence };
      }),
    },
  };
}
