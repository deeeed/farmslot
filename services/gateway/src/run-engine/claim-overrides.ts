import { selectedRecipeClaims } from '@farmslot/adapter-sdk/evidence';
import {
  acceptanceRowExecution,
  type ClaimOverrideAuthority,
  projectClaimUntestableOverride,
  type ProjectVisualClaimReviewPolicy,
  type RecipeClaimEvidence,
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

/**
 * Task rows transport the selected attempt, or for QA each row's case execution.
 * Only stored gateway receipts may change their review verdict.
 */
export function projectGateAcceptance(
  acceptance: GateAcceptanceRead,
  run: Run,
  inputs: readonly RecordedEvidencePackageInput[],
  policy?: ProjectVisualClaimReviewPolicy,
  selection?: VisualReviewReadSelection,
): GateAcceptanceRead {
  const ledger = acceptance.ledger;
  if (ledger?.schemaVersion !== 2) return acceptance;
  const projections = new Map<
    RecordedEvidencePackageInput,
    { reviewed: ReturnType<typeof reviewedRecipeClaims>; selected: RecipeClaimEvidence[] }
  >();
  const projection = (input: RecordedEvidencePackageInput) => {
    let derived = projections.get(input);
    if (!derived) {
      derived = {
        reviewed: reviewedRecipeClaims(run, input, policy, selection),
        selected: selectedRecipeClaims(input),
      };
      projections.set(input, derived);
    }
    return derived;
  };
  return {
    ...acceptance,
    ledger: {
      ...ledger,
      criteria: ledger.criteria.map((row) => {
        const input = inputs.find(
          (candidate) => candidate.claims?.recipeRunId === acceptanceRowExecution(ledger, row),
        );
        if (!input?.claims) return row;
        const { reviewed, selected } = projection(input);
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
        if (projected.verdict === 'untestable')
          return { ...row, ...projected, evidence: row.evidence };
        const current = reviewed.find(({ id }) => id === row.id);
        return {
          ...row,
          ...current,
          // A receipt or code review changed the verdict; the engine verdict stays visible.
          ...(current && current.verdict !== row.verdict ? { engineVerdict: row.verdict } : {}),
          evidence: row.evidence,
        };
      }),
    },
  };
}
