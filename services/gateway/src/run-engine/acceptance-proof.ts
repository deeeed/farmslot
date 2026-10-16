import { isDeepStrictEqual } from 'node:util';

import { validateRecordedEvidencePackage } from '@farmslot/adapter-sdk/evidence';
import {
  isAuthorizedOverride,
  isRecord,
  type ProjectVisualClaimReviewPolicy,
  type RecordedEvidencePackageInput,
  type Run,
  type RunGatePrerequisiteReason,
} from '@farmslot/protocol';

import {
  appliedClaimOverrideReceiptIds,
  claimOverrideAuthority,
  projectGateAcceptance,
} from './claim-overrides.js';
import { appliedVisualJudgmentReceiptIds, reviewedRecipeClaims } from './claim-reviews.js';
import type { GateAcceptanceRead } from './gate-prerequisites.js';

interface RecordedAcceptanceContext {
  run: Run;
  acceptance: GateAcceptanceRead;
  inputs: readonly RecordedEvidencePackageInput[];
  visualPolicy?: ProjectVisualClaimReviewPolicy;
  claimOverrideReceiptIds?: readonly string[];
  visualJudgmentReceiptIds?: readonly string[];
  qaOutput?: boolean;
  reviewBinding?: 'captured' | 'current' | 'approved';
}

/** One evidence/claim assessment for completion, publication and inherited proof. */
export function assessRecordedAcceptance(context: RecordedAcceptanceContext): {
  acceptance: GateAcceptanceRead;
  reasons: RunGatePrerequisiteReason[];
} {
  const { inputs, visualPolicy, qaOutput = false } = context;
  const approved = context.reviewBinding === 'approved';
  const run = approved
    ? {
        ...context.run,
        claimOverrideReceipts: context.run.claimOverrideReceipts?.filter(({ id }) =>
          context.claimOverrideReceiptIds?.includes(id),
        ),
      }
    : context.run;
  const selection = approved
    ? { historical: true, capturedIds: context.visualJudgmentReceiptIds ?? [] }
    : undefined;
  const acceptance = projectGateAcceptance(
    context.acceptance,
    run,
    inputs,
    visualPolicy,
    selection,
  );
  const reasons: RunGatePrerequisiteReason[] = [];
  if (
    context.reviewBinding !== 'current' &&
    !isDeepStrictEqual(
      appliedClaimOverrideReceiptIds(context.run, inputs),
      [...(context.claimOverrideReceiptIds ?? [])].sort(),
    )
  )
    reasons.push({
      code: 'evidence-override-refresh-required',
      prerequisite: 'evidence',
      message: 'Human claim overrides changed. Refresh and review the gate package.',
      actionId: 'hold',
    });
  if (
    context.reviewBinding !== 'current' &&
    !isDeepStrictEqual(
      appliedVisualJudgmentReceiptIds(
        context.run,
        inputs,
        visualPolicy,
        approved ? { historical: true } : selection,
      ),
      [...(context.visualJudgmentReceiptIds ?? [])].sort(),
    )
  )
    reasons.push({
      code: 'evidence-override-refresh-required',
      prerequisite: 'evidence',
      message:
        'Visual review or its delegation policy changed. Refresh and review the gate package.',
      actionId: 'hold',
    });
  const valid =
    inputs.length > 0 &&
    inputs.every((input) => validateRecordedEvidencePackage(input).status === 'valid');
  const projectedRunId = acceptance.ledger?.recipeRunId;
  const projectedIdentityMatches =
    (!qaOutput && acceptance.criteria.length === 0) ||
    (acceptance.ledger?.schemaVersion === 2 &&
      typeof projectedRunId === 'string' &&
      projectedRunId.length > 0 &&
      inputs.some((input) => input.claims?.recipeRunId === projectedRunId));
  const executionSatisfied = inputs.every(
    (input) =>
      isRecord(input.summary) &&
      input.summary.status === 'pass' &&
      input.summary.stopAfterNode === undefined,
  );
  const reviewed = inputs.map((input) =>
    valid && input.claims
      ? reviewedRecipeClaims(run, input, visualPolicy, selection)
      : (input.claims?.criteria ?? []),
  );
  const claimsSatisfied = inputs.every(
    (input, index) =>
      input.claims &&
      ['complete', 'not-required'].includes(input.claims.recording.status) &&
      reviewed[index]!.every(
        (claim) =>
          claim.verdict === 'proven' ||
          // An output review retains unreviewed visual claims for its
          // reviewer. Completing execution never approves those claims.
          (qaOutput &&
            claim.verdict === 'awaiting-review' &&
            ['visual', 'mixed'].includes(claim.proofMode)) ||
          acceptance.criteria.some(
            (criterion) =>
              criterion.id === claim.id &&
              input.claims?.recipeRunId === projectedRunId &&
              input.claims &&
              acceptance.ledger?.criteria.some(
                (row) =>
                  row.id === criterion.id &&
                  isAuthorizedOverride(
                    row,
                    input.claims!.criteria.find(({ id }) => id === claim.id)!,
                    claimOverrideAuthority(run, input),
                  ),
              ) &&
              acceptance.issues.length === 0,
          ),
      ),
  );
  const bound = acceptance.criteria.every((criterion) =>
    inputs.some(
      (input, index) =>
        input.claims?.recipeRunId === projectedRunId &&
        reviewed[index]?.some(
          (claim) =>
            claim.id === criterion.id &&
            claim.text.trim() === criterion.text.trim() &&
            (claim.verdict ===
              acceptance.ledger?.criteria.find((row) => row.id === criterion.id)?.verdict ||
              acceptance.ledger?.criteria.some(
                (row) =>
                  row.id === criterion.id &&
                  isAuthorizedOverride(
                    row,
                    input.claims!.criteria.find(({ id }) => id === claim.id)!,
                    claimOverrideAuthority(run, input),
                  ),
              )),
        ),
    ),
  );

  if (!valid || !projectedIdentityMatches || (qaOutput && (!executionSatisfied || !bound))) {
    reasons.push({
      code: valid && !projectedIdentityMatches ? 'evidence-execution-mismatch' : 'evidence-invalid',
      prerequisite: 'evidence',
      message:
        valid && !projectedIdentityMatches
          ? 'Task verdicts belong to another recipe execution. Run the recipe and refresh the gate package.'
          : 'Required claim evidence is structurally invalid or incomplete.',
      actionId: 'hold',
    });
  } else {
    const policies: Array<[RunGatePrerequisiteReason['evidencePolicy'], boolean, string]> = [
      [
        'execution-verdict',
        executionSatisfied,
        'Selected execution results do not satisfy publication policy.',
      ],
      [
        'claim-verdict',
        claimsSatisfied,
        'Recorded claim verdicts do not satisfy publication policy.',
      ],
      ['criterion-binding', bound, 'Recorded claims do not bind all registered criteria.'],
    ];
    for (const [evidencePolicy, satisfied, message] of policies) {
      if (!satisfied)
        reasons.push({
          code: 'evidence-policy-unsatisfied',
          prerequisite: 'evidence',
          evidencePolicy,
          message,
          actionId: 'hold',
        });
    }
  }
  return { acceptance, reasons };
}
