import {
  type ClaimOverrideAuthority,
  projectClaimUntestableOverride,
  type ProjectVisualClaimReviewPolicy,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
  type Run,
} from '@farmslot/protocol';

import { reviewedRecipeClaims } from './claim-reviews.js';
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
        const authority = claimOverrideAuthority(run, input);
        return input.claims.criteria.flatMap(
          (claim) =>
            projectClaimUntestableOverride(claim, authority).overrides?.map(
              ({ receiptId }) => receiptId,
            ) ?? [],
        );
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
): GateAcceptanceRead {
  if (acceptance.ledger?.schemaVersion !== 2) return acceptance;
  const input = inputs.find(
    (input) => input.claims?.recipeRunId === acceptance.ledger?.recipeRunId,
  );
  if (!input?.claims) return acceptance;
  const authority = claimOverrideAuthority(run, input);
  const reviewed = reviewedRecipeClaims(run, input, policy);
  return {
    ...acceptance,
    ledger: {
      ...acceptance.ledger,
      criteria: acceptance.ledger.criteria.map((row) => {
        const claim = input.claims!.criteria.find(({ id }) => id === row.id);
        if (
          !claim ||
          row.overrides !== undefined ||
          row.verdict !== claim.verdict ||
          row.text !== claim.text
        )
          return row;
        const projected = projectClaimUntestableOverride(claim, authority);
        return projected.verdict === 'untestable'
          ? { ...row, ...projected, evidence: row.evidence }
          : { ...row, ...reviewed.find(({ id }) => id === row.id), evidence: row.evidence };
      }),
    },
  };
}
