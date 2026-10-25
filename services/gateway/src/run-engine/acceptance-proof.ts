import { isDeepStrictEqual } from 'node:util';

import {
  selectedRecipeClaims,
  validateRecordedEvidencePackage,
} from '@farmslot/adapter-sdk/evidence';
import {
  acceptanceRowExecution,
  isAuthorizedOverride,
  isRecord,
  type ProjectVisualClaimReviewPolicy,
  type RecordedEvidencePackageInput,
  type Run,
  type RunGatePrerequisiteReason,
} from '@farmslot/protocol';

import { inheritedAcceptanceView } from '../run-completion/inherited-acceptance-view.js';

import {
  appliedClaimOverrideReceiptIds,
  claimOverrideAuthority,
  projectGateAcceptance,
} from './claim-overrides.js';
import {
  appliedVisualJudgmentReceiptIds,
  claimSourceInput,
  reviewedRecipeClaims,
  selectedSourceInputs,
} from './claim-reviews.js';
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
  /** The gate's code review certifies the evidence package head (ADR-062 Amendment 18). */
  codeReviewCertified?: boolean;
  /** Only the already-qualified original rows, never worker-declared exemptions. */
  qualifiedInheritedCriterionIds?: readonly string[];
}

/** One evidence/claim assessment for completion, publication and inherited proof. */
export function assessRecordedAcceptance(context: RecordedAcceptanceContext): {
  acceptance: GateAcceptanceRead;
  reasons: RunGatePrerequisiteReason[];
} {
  const inherited = context.acceptance.inheritedOriginals;
  if (inherited) {
    const ids = new Set(inherited.acceptance.criteria.map(({ id }) => id));
    const fresh = {
      ...context.acceptance,
      criteria: context.acceptance.criteria.filter(({ id }) => !ids.has(id)),
      ledger: context.acceptance.ledger
        ? {
            ...context.acceptance.ledger,
            criteria: context.acceptance.ledger.criteria.filter(({ id }) => !ids.has(id)),
          }
        : null,
    };
    delete fresh.inheritedOriginals;
    const assessed = assessRecordedAcceptance({
      ...context,
      acceptance: fresh,
      qualifiedInheritedCriterionIds: [...ids],
    });
    return {
      reasons: assessed.reasons,
      acceptance: {
        ...assessed.acceptance,
        inheritedOriginals: inherited,
        criteria: context.acceptance.criteria,
        ledger: inheritedAcceptanceView(inherited, assessed.acceptance.ledger),
      },
    };
  }
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
  const selection = {
    ...(approved ? { historical: true, capturedIds: context.visualJudgmentReceiptIds ?? [] } : {}),
    ...(context.codeReviewCertified ? { codeReviewCertified: true } : {}),
  };
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
  const ledger = acceptance.ledger;
  const projectedRunId = ledger?.recipeRunId;
  // A QA ledger row names the case execution it came from; other rows belong to the projection.
  const rowExecution = (claimId: string) => {
    const row = ledger?.criteria.find(({ id }) => id === claimId);
    return row && ledger ? acceptanceRowExecution(ledger, row) : undefined;
  };
  const projectedIdentityMatches =
    (!qaOutput && acceptance.criteria.length === 0) ||
    (ledger?.schemaVersion === 2 &&
      typeof projectedRunId === 'string' &&
      projectedRunId.length > 0 &&
      [projectedRunId, ...ledger.criteria.map((row) => acceptanceRowExecution(ledger, row))].every(
        (runId) => inputs.some((input) => input.claims?.recipeRunId === runId),
      ));
  // A repair's fresh attempt and every retained original must each be a complete passing execution.
  const sources = (input: RecordedEvidencePackageInput) =>
    valid ? selectedSourceInputs(input).map((source) => source.input) : [input];
  const executionSatisfied = inputs.every((input) =>
    sources(input).every(
      (source) =>
        isRecord(source.summary) &&
        source.summary.status === 'pass' &&
        source.summary.stopAfterNode === undefined,
    ),
  );
  const overrideAuthority = (input: RecordedEvidencePackageInput, claimId: string) =>
    claimOverrideAuthority(run, claimSourceInput(input, claimId) ?? input);
  const selectedRaw = (input: RecordedEvidencePackageInput, claimId: string) =>
    (valid ? selectedRecipeClaims(input) : (input.claims?.criteria ?? [])).find(
      ({ id }) => id === claimId,
    );
  const reviewed = inputs.map((input) =>
    valid && input.claims
      ? reviewedRecipeClaims(run, input, visualPolicy, selection)
      : (input.claims?.criteria ?? []),
  );
  // A QA case package answers for the claims it addresses and the rows bound to it,
  // not for criteria another case proves. Any other output judges every claim.
  const judged = (input: RecordedEvidencePackageInput, claimId: string) => {
    const runId = rowExecution(claimId);
    return (
      !qaOutput ||
      runId === undefined ||
      runId === input.claims?.recipeRunId ||
      (selectedRaw(input, claimId)?.recipeNodes.length ?? 0) > 0
    );
  };
  const claimsSatisfied = inputs.every(
    (input, index) =>
      input.claims &&
      sources(input).every(
        (source) =>
          source.claims && ['complete', 'not-required'].includes(source.claims.recording.status),
      ) &&
      reviewed[index]!.every(
        (claim) =>
          context.qualifiedInheritedCriterionIds?.includes(claim.id) ||
          !judged(input, claim.id) ||
          claim.verdict === 'proven' ||
          // An output review retains unreviewed visual claims for its
          // reviewer. Completing execution never approves those claims.
          (qaOutput &&
            claim.verdict === 'awaiting-review' &&
            ['visual', 'mixed'].includes(claim.proofMode)) ||
          acceptance.criteria.some(
            (criterion) =>
              criterion.id === claim.id &&
              input.claims?.recipeRunId === rowExecution(claim.id) &&
              input.claims &&
              acceptance.ledger?.criteria.some(
                (row) =>
                  row.id === criterion.id &&
                  isAuthorizedOverride(
                    row,
                    selectedRaw(input, claim.id)!,
                    overrideAuthority(input, claim.id),
                  ),
              ) &&
              acceptance.issues.length === 0,
          ),
      ),
  );
  const bound = acceptance.criteria.every((criterion) =>
    inputs.some(
      (input, index) =>
        input.claims?.recipeRunId === rowExecution(criterion.id) &&
        reviewed[index]?.some(
          (claim) =>
            claim.id === criterion.id &&
            claim.text.trim() === criterion.text.trim() &&
            (!criterion.proofMode || claim.proofMode === criterion.proofMode) &&
            (claim.verdict ===
              acceptance.ledger?.criteria.find((row) => row.id === criterion.id)?.verdict ||
              acceptance.ledger?.criteria.some(
                (row) =>
                  row.id === criterion.id &&
                  isAuthorizedOverride(
                    row,
                    selectedRaw(input, claim.id)!,
                    overrideAuthority(input, claim.id),
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
