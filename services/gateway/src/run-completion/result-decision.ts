// result-decision.ts — ADR-065 Amendment 7: a delivered result that review or
// a completion prerequisite did not accept waits in `needs-decision` for one
// person's choice (send back, accept, close) instead of ending `failed`.

import { randomUUID } from 'node:crypto';

import {
  type DecisionAction,
  Events,
  hasDeliveredResult,
  isHeldForResultDecision,
  pendingResultDecision,
  PipelineSteps,
  RESULT_DECISION_ACTION_LABELS,
  type ResultDecisionActionId,
  type ResultDecisionActionState,
  type ResultDecisionDelivered,
  type ResultDecisionPayload,
  type ReviewIssue,
  type Run,
  type RunDecision,
  type RunGatePrerequisiteReason,
  supersedePendingResultDecisions,
} from '@farmslot/protocol';

import { findingsDigest } from '../core/findings-digest.js';
import type { ReviewResult } from '../review/orchestrator.js';
import { completionVerificationMode } from '../run-engine/push-verification.js';
import { captureEpisodeAfterRelease } from '../run-lifecycle/episode-capture-effect.js';
import {
  operatorCompletionCollaborators,
  terminalTransitionDeps,
} from '../run-lifecycle/terminal-transition.js';
import { withRunTransition } from '../run-lifecycle/transition-coordinator.js';
import {
  routeRunTransition,
  RunTransitionRefusedError,
} from '../run-lifecycle/transition-router.js';
import {
  dropParkedValidationBranch,
  isValidationRun,
  type ParkedValidationCommits,
  parkValidationRunCommits,
} from '../run-lifecycle/validation-run-commits.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';
import { currentSessionPrincipal } from '../security/work-originator.js';

export type ResultDecisionStop = ResultDecisionPayload['stoppedAt'];

/** Thrown by REVIEW when findings remain, no fix can run, and a result was delivered. */
export class ResultDecisionHoldError extends Error {
  constructor(
    message: string,
    readonly stepInputs: Record<string, unknown>,
    readonly stepOutputs: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ResultDecisionHoldError';
  }
}

/** The ADR-065 Amendment 7 predicate, with this run's push or commit requirement. */
export function runDeliveredResult(run: Run): boolean {
  return hasDeliveredResult(run, completionVerificationMode(run));
}

function isResultDecisionActionId(value: string): value is ResultDecisionActionId {
  return value === 'send-back' || value === 'accept-result' || value === 'close-result';
}

const STYLES: Record<ResultDecisionActionId, DecisionAction['style']> = {
  'send-back': 'primary',
  'accept-result': 'secondary',
  'close-result': 'danger',
};

function decisionAction(id: ResultDecisionActionId): DecisionAction {
  return { id, label: RESULT_DECISION_ACTION_LABELS[id], style: STYLES[id] };
}

/** The output review a held run keeps as its snapshot's evidence. */
function pendingOutputReview(run: Run): RunDecision | undefined {
  return [...run.decisions]
    .reverse()
    .find((decision) => !decision.resolvedAt && decision.payload?.kind === 'output-review');
}

function delivered(run: Run, stoppedAt: ResultDecisionStop): ResultDecisionDelivered {
  const review = run.steps.find((step) => step.name === PipelineSteps.REVIEW)?.outputs;
  const headSha = (review?.reviewSnapshot as { headSha?: unknown } | undefined)?.headSha;
  if (stoppedAt === 'review' && typeof headSha === 'string')
    return { headSha, ...(run.branch ? { branch: run.branch } : {}) };
  return { reportPath: run.output?.reportPath ?? '', manifestDigest: run.output!.manifestDigest };
}

function reviewFindings(run: Run): ReviewIssue[] {
  const issues = run.steps.find((step) => step.name === PipelineSteps.REVIEW)?.outputs?.issues;
  return Array.isArray(issues) ? (issues as ReviewIssue[]) : [];
}

function refusal(run: Run, stoppedAt: ResultDecisionStop): ResultDecisionPayload['refusal'] {
  // The failed COMPLETE or FINALIZE step: a gate refusal lists its reasons, a
  // refused publish package only says why.
  const step = run.steps.find((entry) => entry.name === stoppedAt && entry.status === 'failed');
  if (!step) return undefined;
  const readiness = (
    step.outputs?.gatePrerequisiteRefusal as
      | { readiness?: { reasons?: RunGatePrerequisiteReason[] } }
      | undefined
  )?.readiness;
  return {
    message: step.detail ?? run.error ?? 'A completion prerequisite was refused.',
    reasons: readiness?.reasons ?? [],
  };
}

async function sendBackState(
  run: Run,
  stoppedAt: ResultDecisionStop,
): Promise<ResultDecisionActionState> {
  if (stoppedAt !== 'review') return { id: 'send-back', available: true, requiresReason: false };
  const { assertReviewRoundAvailable } = await import('../review/review-round-budget.js');
  try {
    await assertReviewRoundAvailable(run);
    return { id: 'send-back', available: true, requiresReason: false };
  } catch (error) {
    return {
      id: 'send-back',
      available: false,
      unavailableReason: error instanceof Error ? error.message : String(error),
      requiresReason: false,
    };
  }
}

function acceptState(run: Run, stoppedAt: ResultDecisionStop): ResultDecisionActionState {
  const unavailableReason =
    stoppedAt !== 'review'
      ? 'A refused completion prerequisite cannot be accepted. Send it back once it is fixed, or close it.'
      : run.completionPolicy !== 'artifact-only'
        ? 'Accept settles without publishing; a publishing run publishes only at its gate. Send it back or close it.'
        : run.output?.captureError
          ? 'The report could not be captured. Refresh it before accepting.'
          : undefined;
  return unavailableReason
    ? { id: 'accept-result', available: false, unavailableReason, requiresReason: true }
    : { id: 'accept-result', available: true, requiresReason: true };
}

/** One line on why the run stopped; the findings or refused prerequisites follow it. */
function decisionReason(
  run: Run,
  stoppedAt: ResultDecisionStop,
  findings: ReviewIssue[] | undefined,
  refused: ResultDecisionPayload['refusal'],
): string {
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  if (stoppedAt === 'review') {
    const review = run.steps.find((step) => step.name === PipelineSteps.REVIEW)?.outputs;
    const attempts =
      typeof review?.retryCount === 'number' && typeof review.maxRetries === 'number'
        ? ` after ${review.retryCount}/${review.maxRetries} fix attempts`
        : '';
    const undelivered =
      typeof review?.fixDeliveryFailure === 'string'
        ? ` The fix was not delivered: ${review.fixDeliveryFailure}`
        : '';
    return `Review found ${plural(findings?.length ?? 0, 'issue')}${attempts}.${undelivered}`;
  }
  const step = stoppedAt === 'complete' ? 'COMPLETE' : 'FINALIZE';
  const unmet = refused?.reasons.length ?? 0;
  return unmet
    ? `${step} was refused: ${plural(unmet, 'prerequisite')} not met.`
    : `${step} was refused.`;
}

/** One result decision on the run's current state. */
export async function buildResultDecision(
  run: Run,
  stoppedAt: ResultDecisionStop,
): Promise<RunDecision> {
  const findings = stoppedAt === 'review' ? reviewFindings(run) : undefined;
  const refused = stoppedAt === 'review' ? undefined : refusal(run, stoppedAt);
  const reason = decisionReason(run, stoppedAt, findings, refused);
  const outputReview = pendingOutputReview(run);
  const payload: ResultDecisionPayload = {
    kind: 'result-decision',
    stoppedAt,
    reason,
    ...(findings ? { findings } : {}),
    ...(refused ? { refusal: refused } : {}),
    delivered: delivered(run, stoppedAt),
    findingsDigest: findingsDigest(findings ?? refused?.reasons ?? []),
    ...(outputReview ? { outputReviewDecisionId: outputReview.id } : {}),
    actions: [
      await sendBackState(run, stoppedAt),
      acceptState(run, stoppedAt),
      { id: 'close-result', available: true, requiresReason: false },
    ],
  };
  return {
    id: randomUUID(),
    type: 'engine_result_decision',
    title: `${run.ticketOrPr || `Run ${run.id.slice(0, 8)}`} — result needs a decision`,
    description: reason,
    actions: payload.actions.map((action) => decisionAction(action.id)),
    createdAt: new Date().toISOString(),
    payload,
  };
}

async function publishDecision(run: Run, decision: RunDecision | undefined): Promise<void> {
  const { broadcastEvent } = await import('../server.js');
  broadcastEvent(Events.RUN_UPDATED, { run });
  if (decision) {
    const { pendingDecisionForRun } = await import('../run-engine/decision-projection.js');
    broadcastEvent(Events.RUN_DECISION_NEW, {
      runId: run.id,
      decision: pendingDecisionForRun(run, decision),
      slotId: run.slotId,
    });
  }
}

/**
 * Hold a run that delivered a result for one person's decision. Keeps its
 * worker branch, checkout and slot under the ADR-054 operator-wait boundary.
 * `settlingStatus` re-projects a run another writer already settled (restart).
 */
export async function holdRunForResultDecision(
  runId: string,
  stoppedAt: ResultDecisionStop,
  reason: string,
  options: { settlingStatus?: Run['status']; patch?: Partial<Run> } = {},
): Promise<Run | null> {
  const run = getRun(runId);
  if (!run) return null;
  const decision = await buildResultDecision({ ...run, ...options.patch }, stoppedAt);
  // Everything the hold writes, so an unrecorded hold can be put back.
  const restored = new Set<keyof Run>([
    'status',
    'error',
    'completedAt',
    'decisions',
    ...(Object.keys(options.patch ?? {}) as (keyof Run)[]),
  ]);
  const before: Partial<Run> = {};
  for (const key of restored) Object.assign(before, { [key]: run[key] });
  const now = new Date().toISOString();
  let held: Run;
  try {
    const result = await routeRunTransition(
      { kind: 'hold-result', runId, actor: 'engine' },
      terminalTransitionDeps({
        kind: 'hold-result',
        runId,
        actor: 'engine',
        patch: {
          ...options.patch,
          status: 'needs-decision',
          error: reason,
          completedAt: undefined,
          // A run held again (after a replay or a failed send-back) has one pending decision.
          decisions: [
            ...supersedePendingResultDecisions(getRun(runId)?.decisions ?? run.decisions, now),
            decision,
          ],
        },
        ...(options.settlingStatus ? { settlingStatus: options.settlingStatus } : {}),
        persist: (next) => persistRunNow(next, 'held for a result decision'),
        collaborators: operatorCompletionCollaborators((next) => publishDecision(next, decision)),
      }),
    );
    held = result.run;
  } catch (error) {
    // A cancel or another settlement that won the race refuses the hold; any
    // other failure is the caller's to handle. The router mutates before it
    // persists, so an unrecorded hold is put back first.
    if (!(error instanceof RunTransitionRefusedError)) {
      if (getRun(runId)?.decisions.some((entry) => entry.id === decision.id))
        updateRun(runId, before);
      throw error;
    }
    console.warn(`[result-decision] hold for ${runId.slice(0, 8)} refused: ${error.message}`);
    return null;
  }
  try {
    const { reconcileRunPosture } = await import('../run-engine/resource-posture.js');
    await reconcileRunPosture({ runId, boundary: 'operator-wait' });
  } catch (error) {
    console.warn(
      `[result-decision] operator-wait posture for ${runId.slice(0, 8)} deferred: ${(error as Error).message}`,
    );
  }
  return held;
}

/**
 * Re-present the pending result decision on the run's current state: a new
 * output snapshot, a granted review round, or a restart. The old one resolves
 * `superseded`, so an action taken on it is refused.
 */
export async function representResultDecision(runId: string): Promise<Run | null> {
  return withRunTransition(runId, async () => {
    const run = getRun(runId);
    const previous = run && pendingResultDecision(run);
    if (!run || !isHeldForResultDecision(run) || previous?.payload?.kind !== 'result-decision')
      return null;
    const next = await buildResultDecision(run, previous.payload.stoppedAt);
    const updated = updateRun(runId, {
      decisions: [
        ...supersedePendingResultDecisions(run.decisions, new Date().toISOString()),
        next,
      ],
    });
    await persistRunNow(updated, 'result decision re-presented');
    await publishDecision(updated, next);
    return updated;
  });
}

/** The review REVIEW recorded on its step, when a send-back can resume it. */
export function recordedReviewResult(
  outputs: Record<string, unknown> | undefined,
): ReviewResult | undefined {
  if (
    !outputs ||
    outputs.verdict !== 'issues' ||
    !Array.isArray(outputs.issues) ||
    outputs.issues.length === 0 ||
    typeof outputs.retryCount !== 'number'
  )
    return undefined;
  const text = (value: unknown): value is string => typeof value === 'string';
  const object = (value: unknown) => typeof value === 'object' && value !== null;
  return {
    verdict: 'issues',
    issues: outputs.issues as ReviewIssue[],
    retryCount: outputs.retryCount,
    ...(text(outputs.reviewId) ? { reviewId: outputs.reviewId } : {}),
    ...(outputs.mode === 'warm' || outputs.mode === 'cold' ? { mode: outputs.mode } : {}),
    ...(typeof outputs.maxRetries === 'number' ? { maxRetries: outputs.maxRetries } : {}),
    ...(typeof outputs.feedbackSent === 'boolean' ? { feedbackSent: outputs.feedbackSent } : {}),
    ...(text(outputs.validationDepth)
      ? { validationDepth: outputs.validationDepth as ReviewResult['validationDepth'] }
      : {}),
    ...(Array.isArray(outputs.attempts)
      ? { attempts: outputs.attempts as ReviewResult['attempts'] }
      : {}),
    ...(object(outputs.reviewSnapshot)
      ? { reviewSnapshot: outputs.reviewSnapshot as ReviewResult['reviewSnapshot'] }
      : {}),
    ...(object(outputs.fixDelta) ? { fixDelta: outputs.fixDelta as ReviewResult['fixDelta'] } : {}),
    ...(object(outputs.session) ? { session: outputs.session as ReviewResult['session'] } : {}),
    ...(text(outputs.reviewerSessionId) ? { reviewerSessionId: outputs.reviewerSessionId } : {}),
    ...(Array.isArray(outputs.timeline)
      ? { timeline: outputs.timeline as ReviewResult['timeline'] }
      : {}),
    ...(text(outputs.taskProgressArtifactPath)
      ? { taskProgressArtifactPath: outputs.taskProgressArtifactPath }
      : {}),
  };
}

const sendBackReviews = new Map<string, ReviewResult>();

/** The recorded review a send-back resumes: the review step reads it once. */
export function takeSendBackReview(runId: string): ReviewResult | undefined {
  const review = sendBackReviews.get(runId);
  sendBackReviews.delete(runId);
  return review;
}

export interface ResolveResultDecisionParams {
  runId: string;
  decisionId: string;
  actionId: string;
  reason?: string;
}

/** Settle a held run through one result-decision action (ADR-065 Amendment 7). */
export async function resolveResultDecision(
  params: ResolveResultDecisionParams,
  options: { releaseSlot?: boolean } = {},
): Promise<Run> {
  const actionId = params.actionId;
  if (!isResultDecisionActionId(actionId))
    throw new Error(`Invalid result decision action: ${params.actionId}`);
  const reason = params.reason?.trim() || undefined;
  let stoppedAt: ResultDecisionStop = 'review';
  let reasonOfHold = '';
  let workerFeedback = '';
  let resume: ReviewResult | undefined;
  let settled: Run;
  try {
    settled = await withRunTransition(params.runId, async () => {
      const run = getRun(params.runId);
      if (!run) throw new Error(`Run not found: ${params.runId}`);
      const decision = run.decisions.find((entry) => entry.id === params.decisionId);
      if (!decision || decision.payload?.kind !== 'result-decision')
        throw new Error(`Result decision not found: ${params.decisionId}`);
      if (
        decision.resolvedAt ||
        !isHeldForResultDecision(run) ||
        pendingResultDecision(run) !== decision
      )
        throw new Error('This result decision is no longer pending. Refresh the run.');
      const payload = decision.payload;
      stoppedAt = payload.stoppedAt;
      reasonOfHold = payload.reason;
      workerFeedback = [
        payload.refusal?.message ?? payload.reason,
        ...(payload.refusal?.reasons.map((entry) => entry.message) ?? []),
      ].join('\n');
      if (
        payload.outputReviewDecisionId &&
        run.decisions.find((entry) => entry.id === payload.outputReviewDecisionId)?.resolvedAt
      )
        throw new StaleResultDecisionError();
      const state: ResultDecisionActionState =
        actionId === 'send-back'
          ? await sendBackState(run, payload.stoppedAt)
          : actionId === 'accept-result'
            ? acceptState(run, payload.stoppedAt)
            : { id: actionId, available: true, requiresReason: false };
      if (!state.available) throw new Error(state.unavailableReason ?? 'Action unavailable');
      if (actionId === 'send-back' && payload.stoppedAt === 'review') {
        resume = recordedReviewResult(
          run.steps.find((step) => step.name === PipelineSteps.REVIEW)?.outputs,
        );
        if (!resume)
          throw new Error('The recorded review cannot be resumed. Accept or close the result.');
      }
      if (actionId === 'accept-result' && !reason)
        throw new Error('Accepting a result needs a written reason.');
      const now = new Date().toISOString();
      const receipt = {
        action: actionId,
        principalId: currentSessionPrincipal()?.id ?? 'system',
        ...(reason ? { reason } : {}),
        decidedAt: now,
        delivered: payload.delivered,
        findingsDigest: payload.findingsDigest,
      };
      const { bumpRunGeneration, cancelRunEngine } = await import('../run-engine/orchestrator.js');
      cancelRunEngine(params.runId);
      bumpRunGeneration(params.runId);
      const resolveDecisions = (outputReviewAction: string | null) =>
        run.decisions.map((entry) =>
          entry.id === decision.id
            ? { ...entry, resolvedAt: now, resolvedAction: actionId }
            : outputReviewAction && !entry.resolvedAt && entry.payload?.kind === 'output-review'
              ? { ...entry, resolvedAt: now, resolvedAction: outputReviewAction }
              : entry,
        );
      if (actionId === 'send-back') {
        // REVIEW resumes its fix loop. Completion stays held until feedback
        // reaches its worker; only a new worker signal may advance it again.
        if (resume) sendBackReviews.set(params.runId, resume);
        const updated = updateRun(params.runId, {
          decisions: resolveDecisions(null),
          resultDecisionReceipt: receipt,
          error: undefined,
          // Whatever the run ends as next gets its own analytics record.
          analyticsEmittedAt: undefined,
          ...(payload.stoppedAt === 'review' ? { status: 'reviewing' as const } : {}),
        });
        await persistRunNow(updated, 'result sent back');
        return updated;
      }
      const patch: Partial<Run> = {
        status: 'done',
        completedAt: now,
        // An accepted result settles the stop reason; a closed one keeps it.
        ...(actionId === 'accept-result' ? { error: undefined } : {}),
        // Steps after a REVIEW hold never run once the result is settled.
        steps: run.steps.map((step) =>
          step.status === 'pending' ? { ...step, status: 'skipped' as const } : step,
        ),
        decisions: resolveDecisions(actionId === 'accept-result' ? 'mark-reviewed' : 'close-run'),
        resultDecisionReceipt: receipt,
        // A later recapture on a settled run raises no new output review.
        ...(run.output ? { output: { ...run.output, closedAt: run.output.closedAt ?? now } } : {}),
        analyticsEmittedAt: undefined,
      };
      const { publishCompletedRun } = await import('../methods/run/lifecycle-control.js');
      const result = await routeRunTransition(
        { kind: actionId, runId: params.runId, actor: 'operator' },
        terminalTransitionDeps({
          kind: actionId,
          runId: params.runId,
          actor: 'operator',
          patch,
          settlingStatus: 'needs-decision',
          persist: (next) => persistRunNow(next, `result decision ${actionId}`),
          collaborators: operatorCompletionCollaborators(async (next) => {
            await publishCompletedRun(next);
          }),
        }),
      );
      return result.run;
    });
  } catch (error) {
    // Re-present on the current snapshot, then refuse the stale action.
    if (error instanceof StaleResultDecisionError) await representResultDecision(params.runId);
    throw error;
  }
  if (actionId === 'send-back')
    await sendBack(settled, stoppedAt, reasonOfHold, params.decisionId, workerFeedback, reason);
  else {
    // Released outside the run lock, like other operator terminal actions; the episode follows.
    if (settled.slotId && options.releaseSlot !== false)
      await releaseSettledSlot(settled, stoppedAt !== 'review');
    await captureEpisodeAfterRelease(params.runId);
  }
  return getRun(params.runId) ?? settled;
}

/** A recapture replaced the output snapshot the decision was presented on. */
export class StaleResultDecisionError extends Error {
  constructor() {
    super('The output changed since this decision was presented. Review the refreshed decision.');
    this.name = 'StaleResultDecisionError';
  }
}

async function sendBack(
  run: Run,
  stoppedAt: ResultDecisionStop,
  reason: string,
  decisionId: string,
  feedback: string,
  note?: string,
): Promise<void> {
  if (stoppedAt !== 'review') {
    const { sendBackCompletion } = await import('./completion-send-back.js');
    const { broadcastEvent } = await import('../server.js');
    try {
      await sendBackCompletion(run, decisionId, feedback, broadcastEvent, note);
    } catch (error) {
      if (isHeldForResultDecision(getRun(run.id) ?? run)) {
        try {
          await holdRunForResultDecision(run.id, stoppedAt, reason);
        } catch (holdError) {
          // The run waits without a decision until restart holds it again; the
          // caller must see both failures.
          throw new AggregateError(
            [error, holdError],
            `${(error as Error).message}. The run could not be held again: ${(holdError as Error).message}`,
          );
        }
      }
      throw error;
    }
    return;
  }
  const { startRun } = await import('../run-engine/orchestrator.js');
  void startRun(run.id).catch((error: unknown) =>
    console.error(
      `[result-decision] send back for ${run.id.slice(0, 8)} failed to start: ${(error as Error).message}`,
    ),
  );
}

async function parkDiscardedValidationCommits(run: Run): Promise<ParkedValidationCommits | null> {
  if (!run.slotId || !isValidationRun(run)) return null;
  const { inspectSlotWorkspace } = await import('../methods/slot/workspace.js');
  const workspace = await inspectSlotWorkspace(run.slotId);
  return workspace.publication === 'unpushed'
    ? parkValidationRunCommits(run, run.slotId, workspace)
    : null;
}

async function releaseSettledSlot(run: Run, discard: boolean): Promise<void> {
  try {
    if (discard) {
      // Close of a retained refused completion is the Amendment 6 named discard.
      const { slotRelease } = await import('../methods/slot/release.js');
      const { broadcastEvent } = await import('../server.js');
      // A validation run's own commits are parked, SHAs recorded, rather than reset away and left
      // on a branch that refuses the next prepare of the same ticket.
      const parked = await parkDiscardedValidationCommits(run);
      const { released } = await slotRelease(
        { slotId: run.slotId!, forceReset: true, expectedRunId: run.id },
        broadcastEvent,
      );
      if (released && parked) await dropParkedValidationBranch(parked);
      return;
    }
    const { releaseCompletedRunSlot } = await import('../methods/run/lifecycle-control.js');
    await releaseCompletedRunSlot(run);
  } catch (error) {
    console.warn(
      `[result-decision] slot release after ${run.id.slice(0, 8)} deferred: ${(error as Error).message}`,
    );
  }
}

/**
 * The Amendment 6 named discard of a held run performs Close: the workspace is
 * already released, so only the decision and the run settle.
 */
export async function closeDiscardedResult(runId: string): Promise<void> {
  const run = getRun(runId);
  const decision = run && isHeldForResultDecision(run) ? pendingResultDecision(run) : undefined;
  if (!decision) return;
  await resolveResultDecision(
    { runId, decisionId: decision.id, actionId: 'close-result', reason: 'Workspace discarded' },
    { releaseSlot: false },
  );
}

/**
 * After an output refresh of a held run: the same bytes keep the decision;
 * a new snapshot or a failed capture re-presents it.
 */
export async function refreshResultDecisionAfterCapture(runId: string): Promise<void> {
  const run = getRun(runId);
  const decision = run && isHeldForResultDecision(run) ? pendingResultDecision(run) : undefined;
  if (!run || !decision || decision.payload?.kind !== 'result-decision') return;
  const outputReview = pendingOutputReview(run);
  const accept = decision.payload.actions.find((action) => action.id === 'accept-result');
  if (
    outputReview?.id === decision.payload.outputReviewDecisionId &&
    accept?.available === acceptState(run, decision.payload.stoppedAt).available
  )
    return;
  await representResultDecision(runId);
}
