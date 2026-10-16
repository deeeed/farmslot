import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { type RecordedEvidencePackageInput } from '@farmslot/adapter-sdk/evidence';
import {
  acceptanceCriteriaMatch,
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  type DecisionAction,
  digestRecipeDocument,
  effectiveRequiredReviewCount,
  EVIDENCE_ATTESTATION_ACTION,
  evidenceAttestationAvailable,
  isEvidencePolicyReason,
  isPrerequisiteGatePayload,
  isRecord,
  isTerminalRunStatus,
  qualifyingPassingReviews,
  qualifyingTerminalReviewInputs,
  type ReadyGatePrPackage,
  registeredAcceptanceCriteria,
  type ReviewStatus,
  type Run,
  type RunDecision,
  type RunGatePrerequisiteReason,
  type RunGateReadiness,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { ORCHESTRATOR_LOCALITY } from '../core/slot-io.js';
import { assertQaCompletion } from '../qa/completion.js';
import { parseStructuredReviewFeedback } from '../review/feedback.js';
import { runReviewRoundBudget } from '../review/review-round-budget.js';
import { reviewedInputsAwaitingReview } from '../review/reviewed-inputs.js';
import { reviewResultArtifactPath } from '../review/terminal-result.js';
import { readReviewWorkspaceCompletion } from '../review-workspaces/task.js';
import type { InheritedAcceptanceCandidate } from '../run-completion/inherited-acceptance.js';
import { isArtifactOnlyRun } from '../run-completion/orchestrator.js';
import { verifyRunOutputReview } from '../run-completion/output.js';
import {
  readReadyGatePreparedPackage,
  verifyReadyGateSelectedEvidenceFiles,
} from '../run-completion/ready-gate-package.js';
import {
  qualifyRetainedRunMetadata,
  retainedRunArtifactManifest,
  retainedRunTaskDirectory,
} from '../run-completion/retained-artifacts.js';
import {
  readRunProgress,
  runDecisionWaitingStatus,
  type RunProgressObservation,
} from '../runners/run-progress.js';
import { getRun, updateRun } from '../runs/store.js';
import {
  type AcceptanceStatusRead,
  readAcceptanceStatusForDisplay,
  readHandoffAcceptanceCriteria,
} from '../tasks/acceptance-status.js';
import {
  readFrozenWorkerTerminalContractForRun,
  validateDeterministicChecksForRun,
} from '../tasks/worker-terminal-contract.js';

import { assessRecordedAcceptance } from './acceptance-proof.js';
import { readVisualReviewPolicy } from './claim-reviews.js';
import { readReviewInputSnapshot } from './diff-artifacts.js';
import {
  APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
  APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  assertPublicationReviewPolicySatisfied,
  buildEvidenceRefreshAction,
  buildUnavailableSnapshotAction,
  isPublishApprovalAction,
  publicationReviewBlockingReason,
  publicationReviewMatchesPreparedPackage,
} from './gate-policy.js';
import { requiresPublicationApproval } from './publication-policy.js';
import {
  readFrozenPublicationRecipeSources,
  readFrozenRecordedEvidenceSources,
  readGateRecordedEvidenceSources,
} from './recorded-evidence-sources.js';
import {
  readReviewArtifacts,
  reviewCommitFromMarkdown,
  reviewRecommendationFromMarkdown,
} from './review-artifacts.js';
import { runSupersededSince } from './run-generation.js';
import { readTaskArtifactText } from './task-artifacts.js';
import { visualRepairEvidenceReasons } from './visual-repair.js';

export interface GatePrerequisiteReaders {
  deterministic(run: Run): Promise<unknown>;
  acceptance(run: Run): Promise<GateAcceptanceRead>;
  progress(run: Run): Promise<RunProgressObservation>;
  qaCompletion(run: Run): ReturnType<typeof assertQaCompletion>;
  /** Retained ADR-062 inputs, bound to the publication or output inventory. */
  recordedEvidence?: (
    run: Run,
    preparedPackage: ReadyGatePrPackage | null,
    qa?: Awaited<ReturnType<typeof assertQaCompletion>>,
  ) => Promise<RecordedEvidencePackageInput[]>;
  reviewResult(run: Run, relativePath: string): Promise<string | undefined>;
  selectedEvidence(run: Run, preparedPackage: ReadyGatePrPackage): Promise<void>;
  reviewDocument(run: Run): Promise<boolean>;
  reviewedInputsAwaitingReview: typeof reviewedInputsAwaitingReview;
}

export interface GateAcceptanceRead extends AcceptanceStatusRead {
  /** Refusals from the existing completion guard, never a display-count verdict. */
  issues: readonly string[];
  inheritedSource?: InheritedAcceptanceCandidate;
}

const require = createRequire(import.meta.url);
const { acceptanceContractIssues } =
  require('@farmslot/agent-runtime/scripts/acceptance-ledger.cjs') as {
    acceptanceContractIssues(
      taskDir: string,
      options: { allowWeak: boolean; deferClaimVerdicts?: boolean; requireFresh?: boolean },
    ): string[];
  };

export async function readGateAcceptance(run: Run): Promise<GateAcceptanceRead> {
  const expected = registeredAcceptanceCriteria(run.ticketData?.acceptanceCriteria ?? []);
  if (!run.taskFile)
    return {
      criteria: [],
      ledger: null,
      issues: [],
      error: 'Task registration is missing',
    };
  try {
    const inheritedSource = run.parentRunId
      ? await import('../run-completion/inherited-acceptance.js').then(
          ({ readInheritedAcceptanceSource }) => readInheritedAcceptanceSource(run),
        )
      : null;
    if (inheritedSource) {
      const taskDir = await retainedRunTaskDirectory(run);
      await qualifyRetainedRunMetadata(run);
      const registered = await readHandoffAcceptanceCriteria(ORCHESTRATOR_LOCALITY, taskDir);
      const acceptance = inheritedSource.acceptance;
      if (
        (expected.length && !acceptanceCriteriaMatch(expected, registered)) ||
        !acceptanceCriteriaMatch(registered, acceptance.criteria)
      )
        throw new Error('Parent acceptance criteria differ from the follow-up task');
      return { ...acceptance, inheritedSource };
    }
    if (run.reviewWorkspace) {
      // Workspace review completion already validates its frozen task, result,
      // report and completion guard through the owning review implementation.
      const result = run.reviewWorkspace.cleanedAt
        ? run.reviewResult
        : (await readReviewWorkspaceCompletion(run.id))?.result;
      return {
        criteria: [],
        ledger: null,
        issues: [],
        ...(!result ? { error: 'Workspace review completion is unavailable' } : {}),
      };
    }
    const taskDir = await retainedRunTaskDirectory(run);
    await qualifyRetainedRunMetadata(run);
    const acceptance = await readAcceptanceStatusForDisplay(ORCHESTRATOR_LOCALITY, taskDir);
    if (acceptance.error) return { ...acceptance, issues: [] };
    if (expected.length && !acceptanceCriteriaMatch(expected, acceptance.criteria))
      return {
        ...acceptance,
        issues: [],
        error: 'Original acceptance registration is missing or changed',
      };
    if (!acceptance.criteria.length) return { ...acceptance, issues: [] };
    const contractText = await readFrozenWorkerTerminalContractForRun({
      ...run,
      taskFile: path.join(taskDir, path.basename(run.taskFile)),
    });
    const contract: unknown = contractText ? JSON.parse(contractText) : null;
    const options = {
      allowWeak:
        isRecord(contract) &&
        isRecord(contract.acceptance) &&
        contract.acceptance.allowWeak === true,
      deferClaimVerdicts: true,
      requireFresh:
        isRecord(contract) &&
        isRecord(contract.acceptance) &&
        contract.acceptance.requireFresh === true,
    };
    return { ...acceptance, issues: acceptanceContractIssues(taskDir, options) };
  } catch (error) {
    // Unreadable authority is an explicit refusal; it never erases the task's ACs.
    return {
      criteria: [],
      ledger: null,
      issues: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Preserve the prerequisite consumer's canonical input array. */
function capturedOutputReviewDecision(run: Run): RunDecision | undefined {
  return run.decisions
    .slice()
    .reverse()
    .find((candidate) => candidate.payload?.kind === 'output-review');
}

export async function readGateRecordedEvidence(
  run: Run,
  preparedPackage: ReadyGatePrPackage | null,
  qa?: Awaited<ReturnType<typeof assertQaCompletion>>,
): Promise<RecordedEvidencePackageInput[]> {
  if (!preparedPackage && run.flowType === 'pr-complete') {
    const inventory = await retainedRunArtifactManifest(run);
    return (await readFrozenPublicationRecipeSources(run, inventory, [], run.artifactBundle)).map(
      ({ input }) => input,
    );
  }
  if (preparedPackage || !isArtifactOnlyRun(run))
    return (await readGateRecordedEvidenceSources(run, preparedPackage)).map(({ input }) => input);
  const decision = capturedOutputReviewDecision(run);
  if (!decision)
    throw new Error('A captured output review is required. Refresh the artifact mirror.');
  const captured = await verifyRunOutputReview(run.id, decision.id, true);
  const inventory = qa
    ? captured.output!.artifactManifest.filter((file) =>
        qa.packages.some((selected) => file.path.startsWith(`artifacts/${selected.path}/`)),
      )
    : captured.output!.artifactManifest;
  if (qa && !inventory.length)
    throw new Error(
      'A required QA case is absent from the captured output. Refresh the artifact mirror.',
    );
  const sources = await readFrozenRecordedEvidenceSources(
    captured,
    inventory,
    [],
    captured.output?.artifactBundle,
  );
  let applicable = sources;
  if (run.flowType === 'qa') {
    // QA owns case selection and revision checks. Retained failed attempts are
    // inspectable history, not additional cases that this execution must pass.
    if (!qa) throw new Error('Current QA case validation is unavailable.');
    applicable = qa.packages.map((selected) => {
      const source = sources.find(
        ({ artifactPrefix }) => artifactPrefix === `artifacts/${selected.path}/`,
      );
      if (!source || digestRecipeDocument(source.input.recipe) !== selected.digest)
        throw new Error(
          'A required QA case is absent or different in the captured output. Refresh the artifact mirror.',
        );
      return source;
    });
  }
  // The reader and QA validation await I/O. Keep the same captured decision and
  // bytes authoritative through their completion, including refresh races.
  const current = await verifyRunOutputReview(run.id, decision.id, true);
  if (current.output?.manifestDigest !== captured.output?.manifestDigest)
    throw new Error('Output review changed while evidence was being checked.');
  return applicable.map(({ input }) => input);
}

const readers: GatePrerequisiteReaders = {
  reviewedInputsAwaitingReview,
  deterministic: validateDeterministicChecksForRun,
  acceptance: readGateAcceptance,
  progress: readRunProgress,
  qaCompletion: (run) => assertQaCompletion(run, { retained: true }),
  recordedEvidence: readGateRecordedEvidence,
  reviewDocument: async (run) => {
    if (run.reviewWorkspace)
      return Boolean(
        run.reviewWorkspace.cleanedAt
          ? run.reviewResult
          : (await readReviewWorkspaceCompletion(run.id))?.result,
      );
    const taskDir = await retainedRunTaskDirectory(run);
    await qualifyRetainedRunMetadata(run);
    const [review, input] = await Promise.all([
      readReviewArtifacts(run.id, run.artifactBundle),
      readReviewInputSnapshot(path.join(taskDir, path.basename(run.taskFile ?? 'TASK.md'))),
    ]);
    const snapshot = input.snapshot;
    return (
      review.hasReview &&
      Boolean(snapshot?.headSha) &&
      snapshot?.source !== 'unavailable' &&
      reviewCommitFromMarkdown(review.reviewMd) === snapshot?.headSha &&
      reviewRecommendationFromMarkdown(review.reviewMd) !== null
    );
  },
  reviewResult: (run, relativePath) =>
    readTaskArtifactText(run, relativePath.slice('artifacts/'.length)),
  selectedEvidence: (run, preparedPackage) =>
    verifyReadyGateSelectedEvidenceFiles(
      run,
      preparedPackage,
      preparedPackage.selectedEvidenceKeys ?? [],
    ),
};

/** Compose owner validators; absent validation is a refusal, never a success. */
export async function collectRunGateReadiness(
  run: Run,
  preparedPackage: ReadyGatePrPackage | null,
  overrides: Partial<GatePrerequisiteReaders> = {},
  phase: 'publication' | 'post-publication' = 'publication',
): Promise<RunGateReadiness> {
  const publicationFulfilled =
    phase === 'post-publication' && Boolean(run.engineState?.publishGate?.humanPublicationAdoption);
  if (phase === 'post-publication' && !publicationFulfilled)
    throw new Error('Post-publication readiness requires a durable human publication receipt');
  const generation = run.engineState?.generation ?? 0;
  const outputDigest = isArtifactOnlyRun(run) ? run.output?.manifestDigest : undefined;
  const outputDecision = outputDigest ? capturedOutputReviewDecision(run) : undefined;
  const source = { ...readers, ...overrides };
  const reasons: RunGatePrerequisiteReason[] = [];
  const retainedPackageHash = run.engineState?.publishGate?.packageHash;
  if (!publicationFulfilled && !preparedPackage && retainedPackageHash) {
    try {
      const retained = await readReadyGatePreparedPackage(run);
      if (
        retained?.id !== run.engineState?.publishGate?.packageId ||
        retained?.packageHash !== retainedPackageHash
      )
        throw new Error('The retained package differs from the current gate identity.');
      preparedPackage = retained;
    } catch (error) {
      reasons.push({
        code: 'evidence-validation-unavailable',
        prerequisite: 'evidence',
        actionId: 'hold',
        message: `The retained gate package could not be read: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const reviewBlock =
    !publicationFulfilled &&
    (preparedPackage || requiresPublicationApproval(run)) &&
    publicationReviewBlockingReason(run, preparedPackage);
  if (reviewBlock)
    reasons.push({
      code: 'review-fix-required',
      prerequisite: 'review',
      message: reviewBlock,
      actionId: 'continue-review-fix',
    });
  const artifactRun = preparedPackage?.artifactBundle
    ? { ...run, artifactBundle: preparedPackage.artifactBundle }
    : run;
  if (run.flowType === 'review-pr') {
    let valid = false;
    try {
      valid = await source.reviewDocument(artifactRun);
    } catch {
      // Invalid completion must remain inspectable with the refusal below.
      valid = false;
    }
    if (!valid)
      reasons.push({
        code: 'review-document-missing',
        prerequisite: 'review',
        message: 'The required reviewer result is missing or invalid.',
        actionId: 'dismiss',
      });
  }
  try {
    await source.deterministic(artifactRun);
  } catch {
    // The owner validator rejects absent/stale/failed receipts. Preserve that refusal.
    reasons.push({
      code: 'deterministic-not-passed',
      prerequisite: 'deterministic',
      message: 'A declared deterministic check has no current passing receipt.',
      actionId: 'hold',
    });
  }
  let acceptance = await source.acceptance(artifactRun);
  if (acceptance.error) {
    reasons.push({
      code: 'acceptance-unreadable',
      prerequisite: 'acceptance',
      message: 'The registered acceptance criteria or their verdicts could not be read.',
      actionId: 'hold',
    });
  } else if (acceptance.issues.length) {
    reasons.push({
      code: 'acceptance-incomplete',
      prerequisite: 'acceptance',
      message: 'The registered acceptance criteria have missing or disallowed verdicts.',
      actionId: 'hold',
    });
  }

  const hasSelectedMedia = preparedPackage?.selectedEvidenceKeys?.length;
  const qaOutput = run.flowType === 'qa' && isArtifactOnlyRun(run) && !preparedPackage;
  if (!publicationFulfilled && (acceptance.criteria.length || hasSelectedMedia)) {
    if (!source.recordedEvidence) {
      reasons.push({
        code: 'evidence-validation-unavailable',
        prerequisite: 'evidence',
        message: 'Recorded evidence validation is unavailable for this execution.',
        actionId: 'hold',
      });
    } else {
      try {
        const qa = qaOutput ? await source.qaCompletion(artifactRun) : undefined;
        const evidenceRun = acceptance.inheritedSource?.run ?? run;
        const evidencePackage = acceptance.inheritedSource?.prPackage ?? preparedPackage;
        const inputs = await source.recordedEvidence(evidenceRun, evidencePackage, qa);
        const visualPolicy = await readVisualReviewPolicy(evidenceRun);
        const assessed = assessRecordedAcceptance({
          run: evidenceRun,
          acceptance,
          inputs,
          visualPolicy,
          qaOutput,
          reviewBinding: acceptance.inheritedSource
            ? 'approved'
            : run.flowType === 'pr-complete' && !evidencePackage && !outputDecision
              ? 'current'
              : 'captured',
          claimOverrideReceiptIds:
            evidencePackage?.claimOverrideReceiptIds ??
            (outputDecision?.payload?.kind === 'output-review'
              ? outputDecision.payload.claimOverrideReceiptIds
              : undefined),
          visualJudgmentReceiptIds:
            evidencePackage?.visualJudgmentReceiptIds ??
            (outputDecision?.payload?.kind === 'output-review'
              ? outputDecision.payload.visualJudgmentReceiptIds
              : undefined),
        });
        acceptance = assessed.acceptance;
        reasons.push(
          ...assessed.reasons,
          ...visualRepairEvidenceReasons(evidenceRun, inputs, evidencePackage),
        );
      } catch (error) {
        // An unreadable frozen closure remains an explicit refusal.
        reasons.push({
          code: 'evidence-validation-unavailable',
          prerequisite: 'evidence',
          message: `The selected frozen evidence package could not be read or validated: ${error instanceof Error ? error.message : String(error)}`,
          actionId: 'hold',
        });
      }
    }
  }
  if (!publicationFulfilled && preparedPackage) {
    try {
      await source.selectedEvidence(run, preparedPackage);
    } catch {
      reasons.push({
        code: 'evidence-selection-invalid',
        prerequisite: 'evidence',
        message: 'The selected evidence bytes no longer match this gate package.',
        actionId: 'hold',
      });
    }

    let recordedPolicySatisfied = false;
    try {
      assertPublicationReviewPolicySatisfied(run, preparedPackage);
      recordedPolicySatisfied = true;
    } catch {
      recordedPolicySatisfied = false;
    }
    const validInputs: ReviewStatus[] = [];
    for (const review of qualifyingTerminalReviewInputs(
      run.engineState?.publishGate?.reviews ?? [],
    )) {
      const artifact = reviewResultArtifactPath(review);
      const raw = artifact ? await source.reviewResult(run, artifact) : undefined;
      if (raw) {
        const result = parseStructuredReviewFeedback(raw, artifact!);
        if (!result.incomplete && result.verdict === review.verdict) validInputs.push(review);
      }
    }
    const validReviews = qualifyingPassingReviews(validInputs);
    const policy = preparedPackage.reviewPolicy ?? {
      minimumReviews: 1,
      requestedBy: 'dispatch' as const,
    };
    const required = effectiveRequiredReviewCount(policy);
    const budget = await runReviewRoundBudget(run);
    const nextStep =
      budget.remaining === 0
        ? `Review budget ${budget.used}/${budget.limit} is exhausted. Ask the lead for a scoped extension, then use farmslot run extend-review-budget ${run.id} and request current-head reviews.`
        : 'Request reviews for the current head and package.';
    const allowedReviewOverrides: string[] = [];
    if (
      validInputs.filter((review) =>
        publicationReviewMatchesPreparedPackage(review, preparedPackage),
      ).length >= required
    )
      allowedReviewOverrides.push(APPROVE_PUBLISH_UNRESOLVED_ACTION);
    if (buildEvidenceRefreshAction(validReviews, preparedPackage))
      allowedReviewOverrides.push(APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION);
    if (buildUnavailableSnapshotAction(validReviews, preparedPackage, policy))
      allowedReviewOverrides.push(APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION);
    if (await source.reviewedInputsAwaitingReview(run)) {
      reasons.push({
        code: 'review-inputs-awaiting-review',
        prerequisite: 'lifecycle',
        message: `Source or evidence changed after review and has not been reviewed at the current head. ${nextStep}`,
        actionId: budget.remaining === 0 ? 'hold' : 'request-review',
      });
    }
    try {
      assertPublicationReviewPolicySatisfied(
        {
          ...run,
          engineState: {
            ...run.engineState,
            publishGate: { ...run.engineState?.publishGate, reviews: validReviews },
          },
        },
        preparedPackage,
      );
    } catch {
      reasons.push({
        code: recordedPolicySatisfied ? 'review-result-invalid' : 'review-result-required',
        prerequisite: 'review',
        message: `Required current-head reviews need valid structured result artifacts for this package. ${nextStep}`,
        actionId: budget.remaining === 0 ? 'hold' : 'request-review',
        allowedReviewOverrides,
      });
    }
  }
  const progress = await source.progress(run);
  let outputInvalidated = false;
  if (outputDigest && outputDecision) {
    try {
      const current = await verifyRunOutputReview(run.id, outputDecision.id, true);
      outputInvalidated =
        current.output?.manifestDigest !== outputDigest ||
        current.taskFile !== run.taskFile ||
        (current.engineState?.generation ?? 0) !== generation ||
        isTerminalRunStatus(current.status) ||
        current.status === 'paused';
    } catch {
      // Failed recapture preserves the digest but retires its decision. The
      // owning snapshot verifier must refuse it before completion can advance.
      outputInvalidated = true;
    }
  } else if (outputDigest) {
    const current = getRun(run.id);
    outputInvalidated =
      current?.output?.manifestDigest !== outputDigest || Boolean(current?.output?.captureError);
  }
  if (
    isTerminalRunStatus(run.status) ||
    run.status === 'paused' ||
    (run.engineState?.generation ?? 0) !== generation ||
    outputInvalidated ||
    run.engineState?.publishGate?.packageHash !== retainedPackageHash
  )
    reasons.push({
      code: 'run-gate-superseded',
      prerequisite: 'lifecycle',
      message: 'The run no longer owns this gate evaluation.',
      actionId: 'hold',
    });
  if (progress.kind === 'making-progress')
    reasons.push({
      code: 'run-work-progressing',
      prerequisite: 'lifecycle',
      message: 'Run work is still progressing.',
      actionId: 'hold',
    });
  if (progress.kind === 'unproven' || progress.kind === 'awaiting-input')
    reasons.push({
      code: 'run-progress-unconfirmed',
      prerequisite: 'lifecycle',
      message: 'The current runner operation cannot be confirmed idle.',
      actionId: 'hold',
    });
  return {
    state:
      progress.kind === 'making-progress' ? 'collecting' : reasons.length ? 'not-ready' : 'ready',
    identity: {
      runId: run.id,
      generation,
      headSha: preparedPackage?.headSha,
      packageHash: preparedPackage?.packageHash,
    },
    reasons,
  };
}

export function advancingGateAction(actionId: string): boolean {
  return (
    actionId === 'ready' ||
    isPublishApprovalAction(actionId) ||
    actionId === 'post' ||
    actionId === 'accept-no-change'
  );
}

export function gateActionsForReadiness<Action extends { id: string }>(
  actions: Action[],
  readiness: RunGateReadiness,
): Action[] {
  return actions.filter((action) =>
    action.id === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION
      ? evidenceAttestationAvailable(readiness)
      : !advancingGateAction(action.id) || gateReasonsForAction(readiness, action.id).length === 0,
  );
}

function gateReasonsForAction(
  readiness: RunGateReadiness,
  actionId?: string,
): RunGatePrerequisiteReason[] {
  const reviewOverride = [
    APPROVE_PUBLISH_UNRESOLVED_ACTION,
    APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
    APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
  ].some((id) => id === actionId);
  return readiness.reasons.filter(
    (reason) =>
      !(
        reviewOverride &&
        reason.prerequisite === 'review' &&
        reason.allowedReviewOverrides?.includes(actionId!)
      ) &&
      !(actionId === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION && isEvidencePolicyReason(reason)),
  );
}

/** Retain the action-filtered refusal so completion does not duplicate gate policy. */
export class RunGateNotReadyError extends GatewayMethodError {
  readonly workProgressingOnly: boolean;

  constructor(readiness: RunGateReadiness, reasons: RunGatePrerequisiteReason[]) {
    super(
      'RUN_GATE_NOT_READY',
      reasons.map((reason) => reason.message).join(' ') || 'Run work is still progressing.',
      {
        details: { readiness },
        userAction: 'Resolve the listed prerequisites, then refresh the gate.',
      },
    );
    this.workProgressingOnly =
      reasons.length > 0 && reasons.every((reason) => reason.code === 'run-work-progressing');
  }
}

export async function assertRunGateReady(
  run: Run,
  preparedPackage: ReadyGatePrPackage | null,
  actionId?: string,
): Promise<RunGateReadiness> {
  const readiness = await collectRunGateReadiness(run, preparedPackage);
  // Artifact-only QA completion presents its unresolved claims for review.
  // This defers only their verdict policy, never package or execution integrity.
  const outputCompletion =
    actionId === 'complete' &&
    run.flowType === 'qa' &&
    isArtifactOnlyRun(run) &&
    !preparedPackage &&
    !readiness.identity.packageHash;
  const reasons = gateReasonsForAction(readiness, actionId).filter(
    (reason) =>
      !(
        outputCompletion &&
        reason.code === 'evidence-policy-unsatisfied' &&
        reason.evidencePolicy === 'claim-verdict'
      ),
  );
  if (
    reasons.length ||
    readiness.state === 'collecting' ||
    (actionId === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION &&
      !evidenceAttestationAvailable(readiness))
  )
    throw new RunGateNotReadyError(readiness, reasons);
  return readiness;
}

/** Assertions may omit a projection; attestation consumers require the checked identity. */
export type GatePrerequisiteAssertion = (
  ...params: Parameters<typeof assertRunGateReady>
) => Promise<RunGateReadiness | void>;

/** Definitions remain on the existing decision so a later receipt can restore its actions. */
export function runGateDefinitionActions(decision: RunDecision): DecisionAction[] {
  const actions = Array.isArray(decision.context?.gateActions)
    ? (decision.context.gateActions as DecisionAction[])
    : decision.actions;
  return decision.type === 'engine_human_gate' &&
    decision.payload?.kind === 'ready' &&
    decision.payload.prPackage &&
    !decision.resolvedAt &&
    !actions.some((action) => action.id === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION)
    ? [...actions, { ...EVIDENCE_ATTESTATION_ACTION }]
    : actions;
}

/** Refresh the existing projection; it is never approval authority. */
export async function refreshRunGateReadiness(
  run: Run,
  overrides: Partial<GatePrerequisiteReaders> = {},
): Promise<Run> {
  const generation = run.engineState?.generation ?? 0;
  const pending = run.decisions.filter(
    (decision) => !decision.resolvedAt && isPrerequisiteGatePayload(decision.payload),
  );
  if (!pending.length || runSupersededSince(run, generation) || isTerminalRunStatus(run.status))
    return run;
  const progress = await (overrides.progress ?? readRunProgress)(run);
  const updates = await Promise.all(
    pending.map(async (decision) => {
      const payload = decision.payload!;
      const prepared = payload.kind === 'ready' ? (payload.prPackage ?? null) : null;
      const readiness = await collectRunGateReadiness(run, prepared, {
        ...overrides,
        progress: async () => progress,
      });
      const definitions = runGateDefinitionActions(decision);
      return {
        ...decision,
        actions: gateActionsForReadiness(definitions, readiness),
        context: { ...decision.context, gateActions: definitions },
        payload: { ...payload, gateReadiness: readiness },
      } as RunDecision;
    }),
  );
  const current = getRun(run.id);
  if (runSupersededSince(current, generation) || isTerminalRunStatus(current!.status))
    return current ?? run;
  // A resolution or package refresh that landed during I/O wins.
  const applicable = updates.filter((update) => {
    const before = pending.find((decision) => decision.id === update.id)!;
    const now = current!.decisions.find((decision) => decision.id === update.id);
    return now && !now.resolvedAt && now.payload === before.payload;
  });
  if (!applicable.length) return current!;
  const decisions = current!.decisions.map(
    (decision) => applicable.find((update) => update.id === decision.id) ?? decision,
  );
  const gate = applicable.at(-1)!;
  const readiness = (gate.payload as { gateReadiness: RunGateReadiness }).gateReadiness;
  const status = runDecisionWaitingStatus(
    current!,
    progress,
    gate.type === 'engine_review_posting' ? 'review_posting' : 'human_gate',
    readiness,
  );
  return current!.status === status && isDeepStrictEqual(current!.decisions, decisions)
    ? current!
    : updateRun(run.id, { status, decisions });
}
