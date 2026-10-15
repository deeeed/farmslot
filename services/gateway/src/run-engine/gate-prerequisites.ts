import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  type RecordedEvidencePackageInput,
  validateRecordedEvidencePackage,
} from '@farmslot/adapter-sdk/evidence';
import {
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  type DecisionAction,
  digestRecipeDocument,
  effectiveRequiredReviewCount,
  EVIDENCE_ATTESTATION_ACTION,
  evidenceAttestationAvailable,
  isAuthorizedOverride,
  isEvidencePolicyReason,
  isPrerequisiteGatePayload,
  isRecord,
  isTerminalRunStatus,
  qualifyingPassingReviews,
  qualifyingTerminalReviewInputs,
  type ReadyGatePrPackage,
  type ReviewStatus,
  type Run,
  type RunDecision,
  type RunGatePrerequisiteReason,
  type RunGateReadiness,
} from '@farmslot/protocol';

import { selectAgentContext } from '../agents/contexts.js';
import { loadSlotVars } from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import { GatewayMethodError } from '../core/method-error.js';
import { shellQuote } from '../core/tmux.js';
import { assertQaCompletion } from '../qa/completion.js';
import { parseStructuredReviewFeedback } from '../review/feedback.js';
import { runReviewRoundBudget } from '../review/review-round-budget.js';
import { reviewedInputsAwaitingReview } from '../review/reviewed-inputs.js';
import { readReviewWorkspaceCompletion } from '../review-workspaces/task.js';
import { isArtifactOnlyRun } from '../run-completion/orchestrator.js';
import { verifyRunOutputReview } from '../run-completion/output.js';
import {
  readReadyGatePreparedPackage,
  verifyReadyGateSelectedEvidenceFiles,
} from '../run-completion/ready-gate-package.js';
import {
  readRunProgress,
  runDecisionWaitingStatus,
  type RunProgressObservation,
} from '../runners/run-progress.js';
import { getRun, updateRun } from '../runs/store.js';
import {
  type AcceptanceStatusRead,
  readAcceptanceStatusForDisplay,
} from '../tasks/acceptance-status.js';
import { agentRuntimeScriptForSlot } from '../tasks/agent-runtime-script.js';
import { resolveContextFilePath } from '../tasks/watcher.js';
import {
  loadTerminalContractForRun,
  validateDeterministicChecksForRun,
} from '../tasks/worker-terminal-contract.js';

import {
  appliedClaimOverrideReceiptIds,
  claimOverrideAuthority,
  projectGateAcceptance,
} from './claim-overrides.js';
import {
  appliedVisualJudgmentReceiptIds,
  readVisualReviewPolicy,
  reviewedRecipeClaims,
} from './claim-reviews.js';
import { readReviewInputSnapshot } from './diff-artifacts.js';
import {
  APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
  APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  assertPublicationReviewPolicySatisfied,
  buildEvidenceRefreshAction,
  buildUnavailableSnapshotAction,
  isPublishApprovalAction,
  publicationReviewMatchesPreparedPackage,
} from './gate-policy.js';
import {
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
}

const require = createRequire(import.meta.url);
const { acceptanceContractIssues } =
  require('@farmslot/agent-runtime/scripts/acceptance-ledger.cjs') as {
    acceptanceContractIssues(
      taskDir: string,
      options: { allowWeak: boolean; deferClaimVerdicts?: boolean },
    ): string[];
  };

export async function readGateAcceptance(
  run: Run,
  sources: { slot: typeof loadSlotVars; contract: typeof loadTerminalContractForRun } = {
    slot: loadSlotVars,
    contract: loadTerminalContractForRun,
  },
): Promise<GateAcceptanceRead> {
  const expected = run.ticketData?.acceptanceCriteria?.filter((text) => text.trim()) ?? [];
  if (!run.taskFile)
    return {
      criteria: [],
      ledger: null,
      issues: [],
      error: 'Task registration is missing',
    };
  try {
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
    // The dispatched primary task is the authority. The retained orchestrator copy
    // can lag behind a fix or lose registration; neither can approve current work.
    if (!run.slotId) throw new Error('Task checkout is unavailable');
    const vars = await sources.slot(run.slotId);
    const primary = selectAgentContext(run, { role: 'primary' });
    if (!primary?.taskFile) throw new Error('Primary task binding is missing');
    const taskFile = resolveContextFilePath(vars.remoteRepo, primary.taskFile, '');
    const taskDir = path.posix.dirname(taskFile);
    const acceptance = await readAcceptanceStatusForDisplay(vars, taskDir);
    if (acceptance.error) return { ...acceptance, issues: [] };
    if (
      expected.length &&
      (acceptance.criteria.length !== expected.length ||
        expected.some((text, index) => acceptance.criteria[index]?.text.trim() !== text.trim()))
    )
      return {
        ...acceptance,
        issues: [],
        error: 'Original acceptance registration is missing or changed',
      };
    if (!acceptance.criteria.length) return { ...acceptance, issues: [] };
    const contract = await sources.contract(run, run.slotId);
    const options = {
      allowWeak: contract.acceptance?.allowWeak === true,
      deferClaimVerdicts: true,
    };
    if (isLocal(vars.host, vars.machine))
      return { ...acceptance, issues: acceptanceContractIssues(taskDir, options) };
    const guard = await agentRuntimeScriptForSlot(vars, 'acceptance-ledger.cjs');
    const script =
      'const { acceptanceContractIssues } = require(process.argv[1]); process.stdout.write(JSON.stringify(acceptanceContractIssues(process.argv[2], JSON.parse(process.argv[3]))));';
    const result = await execOnSlot(
      vars,
      `node -e ${shellQuote(script)} ${shellQuote(guard)} ${shellQuote(taskDir)} ${shellQuote(JSON.stringify(options))}`,
      { timeout: 15_000 },
    );
    if (result.exitCode !== 0) throw new Error('Acceptance guard is unavailable on the task node');
    const issues: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(issues) || issues.some((issue) => typeof issue !== 'string'))
      throw new Error('Acceptance guard returned an invalid result');
    return { ...acceptance, issues: issues as string[] };
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
  const sources = await readFrozenRecordedEvidenceSources(captured, inventory);
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
  qaCompletion: assertQaCompletion,
  recordedEvidence: readGateRecordedEvidence,
  reviewDocument: async (run) => {
    if (run.reviewWorkspace)
      return Boolean(
        run.reviewWorkspace.cleanedAt
          ? run.reviewResult
          : (await readReviewWorkspaceCompletion(run.id))?.result,
      );
    const [review, input] = await Promise.all([
      readReviewArtifacts(run.id),
      readReviewInputSnapshot(run.taskFile),
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
    readTaskArtifactText(run.taskFile, relativePath.slice('artifacts/'.length)),
  selectedEvidence: (run, preparedPackage) =>
    verifyReadyGateSelectedEvidenceFiles(
      run,
      preparedPackage,
      preparedPackage.selectedEvidenceKeys ?? [],
    ),
};

function resultArtifact(review: ReviewStatus): string | undefined {
  return (review.attempts?.at(-1)?.artifactPaths ?? review.artifactPaths)
    ?.slice()
    .reverse()
    .find(
      (entry) =>
        entry.startsWith('artifacts/') &&
        !entry.split('/').includes('..') &&
        path.posix.basename(entry) === 'review-result.json',
    );
}

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
  if (run.flowType === 'review-pr') {
    let valid = false;
    try {
      valid = await source.reviewDocument(run);
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
    await source.deterministic(run);
  } catch {
    // The owner validator rejects absent/stale/failed receipts. Preserve that refusal.
    reasons.push({
      code: 'deterministic-not-passed',
      prerequisite: 'deterministic',
      message: 'A declared deterministic check has no current passing receipt.',
      actionId: 'hold',
    });
  }
  let acceptance = await source.acceptance(run);
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
        const qa = qaOutput ? await source.qaCompletion(run) : undefined;
        const inputs = await source.recordedEvidence(run, preparedPackage, qa);
        const visualPolicy = await readVisualReviewPolicy(run);
        acceptance = projectGateAcceptance(acceptance, run, inputs, visualPolicy);
        const appliedReceipts = appliedClaimOverrideReceiptIds(run, inputs);
        const frozenReceipts =
          preparedPackage?.claimOverrideReceiptIds ??
          (outputDecision?.payload?.kind === 'output-review'
            ? outputDecision.payload.claimOverrideReceiptIds
            : undefined) ??
          [];
        if (!isDeepStrictEqual(appliedReceipts, [...frozenReceipts].sort()))
          reasons.push({
            code: 'evidence-override-refresh-required',
            prerequisite: 'evidence',
            message: 'Human claim overrides changed. Refresh and review the gate package.',
            actionId: 'hold',
          });
        const visualReceipts = appliedVisualJudgmentReceiptIds(run, inputs, visualPolicy);
        const frozenVisualReceipts =
          preparedPackage?.visualJudgmentReceiptIds ??
          (outputDecision?.payload?.kind === 'output-review'
            ? outputDecision.payload.visualJudgmentReceiptIds
            : undefined) ??
          [];
        if (!isDeepStrictEqual(visualReceipts, [...frozenVisualReceipts].sort()))
          reasons.push({
            code: 'evidence-override-refresh-required',
            prerequisite: 'evidence',
            actionId: 'hold',
            message:
              'Visual review or its delegation policy changed. Refresh and review the gate package.',
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
            ? reviewedRecipeClaims(run, input, visualPolicy)
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
            code:
              valid && !projectedIdentityMatches
                ? 'evidence-execution-mismatch'
                : 'evidence-invalid',
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
      const artifact = resultArtifact(review);
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
        message: `Required current-head reviews need valid native result artifacts for this package. ${nextStep}`,
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
