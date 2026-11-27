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
import { reviewSeverityCounts } from '@farmslot/protocol/review-approval-policy.cjs';

import { findingsDigest } from '../core/findings-digest.js';
import { ownsRunSlotCleanup, readSlotRow } from '../core/state.js';
import type { ReviewResult } from '../review/orchestrator.js';
import { completionVerificationMode } from '../run-engine/push-verification.js';
import { reviewBudgetStopReason } from '../run-engine/review-plan.js';
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
import { getRun, persistRunNow, updateRun } from '../runs/store.js';
import { currentSessionPrincipal, runWithSystemOriginator } from '../security/work-originator.js';

import { retainFinalRunArtifacts } from './output.js';

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
  const refused = step.outputs?.gatePrerequisiteRefusal as
    | {
        reasons?: RunGatePrerequisiteReason[];
        readiness?: { reasons?: RunGatePrerequisiteReason[] };
      }
    | undefined;
  return {
    message: step.detail ?? run.error ?? 'A completion prerequisite was refused.',
    reasons: refused?.reasons ?? refused?.readiness?.reasons ?? [],
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
    const outputs = run.steps.find((step) => step.name === PipelineSteps.REVIEW)?.outputs;
    if (!recordedReviewResult(outputs) && !reviewBudgetStopReason(run))
      throw new Error('The recorded review cannot be resumed. Accept or close the result.');
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
      : run.completionPolicy !== 'artifact-only' && !reviewBudgetStopReason(run)
        ? 'Accept settles without publishing; a publishing run publishes only at its gate. Send it back or close it.'
        : run.output?.captureError
          ? 'The report could not be captured. Refresh it before accepting.'
          : undefined;
  return unavailableReason
    ? { id: 'accept-result', available: false, unavailableReason, requiresReason: true }
    : { id: 'accept-result', available: true, requiresReason: true };
}

/**
 * Why review stopped with findings open, so Send back is an informed click (961d55d3):
 * spent fix rounds, a spent review round budget, the no-verdict cap, or fixing that is
 * off or stopped. An undelivered fix says so on its own.
 */
function reviewStopText(review: Record<string, unknown> | undefined): string {
  if (review?.verdict !== 'issues' || typeof review.fixDeliveryFailure === 'string') return '';
  const { retryCount, maxRetries, reason } = review;
  const because = typeof reason === 'string' ? `: ${reason}` : '.';
  if (typeof maxRetries === 'number' && maxRetries <= 0)
    return ' Automatic fix rounds are off for this run.';
  if (typeof retryCount === 'number' && typeof maxRetries === 'number' && retryCount >= maxRetries)
    return ' The fix rounds are spent.';
  if (review.maxRetriesExhausted === true) return ` The review rounds are spent${because}`;
  return typeof reason === 'string'
    ? ` Automatic reviews stopped before the fix rounds were spent${because}`
    : ' Automatic fixing stopped before the fix rounds were spent.';
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
    const budgetStop = reviewBudgetStopReason(run);
    const review = run.steps.find((step) => step.name === PipelineSteps.REVIEW)?.outputs;
    const attempts =
      typeof review?.retryCount === 'number' && typeof review.maxRetries === 'number'
        ? ` after ${review.retryCount}/${review.maxRetries} fix attempts`
        : '';
    const undelivered =
      typeof review?.fixDeliveryFailure === 'string'
        ? ` The fix was not delivered: ${review.fixDeliveryFailure}`
        : '';
    // A refused launch ran no review; its findings are the last verdict's, perhaps since fixed.
    const lastReview =
      review?.findingsFromLastReview === true
        ? ' The findings listed are from the last review.'
        : '';
    if (budgetStop)
      return `${undelivered ? `${undelivered.trim()} ` : ''}${budgetStop}${lastReview}`;
    const counts = Object.entries(reviewSeverityCounts(findings ?? []))
      .filter(([, count]) => count > 0)
      .map(([severity, count]) => `${count} ${severity}`);
    const severities = counts.length ? ` (${counts.join(', ')})` : '';
    const stop = reviewStopText(review);
    return `Review found ${plural(findings?.length ?? 0, 'issue')}${severities}${attempts}.${stop}${undelivered}`;
  }
  const step = stoppedAt === 'complete' ? 'COMPLETE' : 'FINALIZE';
  const unmet = refused?.reasons.length ?? 0;
  return unmet
    ? `${step} was refused: ${plural(unmet, 'prerequisite')} not met.`
    : (refused?.message ?? `${step} was refused.`);
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
  options: { settlingStatus?: Run['status']; patch?: Partial<Run>; announce?: boolean } = {},
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
        collaborators: operatorCompletionCollaborators((next) =>
          publishDecision(next, options.announce === false ? undefined : decision),
        ),
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
    (outputs.verdict !== 'issues' && outputs.verdict !== 'blocked') ||
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

/** The attested adoption receipt an acceptance is bound to, and the generation it was recorded at. */
export interface AdoptedPublicationAcceptance {
  principalId: string;
  receiptId: string;
  generation: number;
}

/**
 * A recorded attested adoption is the person's acceptance of a REVIEW hold: the
 * publication the gate would have produced already exists (ADR-065 Amendment 2).
 */
function adoptedAcceptState(
  run: Run,
  stoppedAt: ResultDecisionStop,
  adopted: AdoptedPublicationAcceptance,
): ResultDecisionActionState {
  const unavailableReason =
    stoppedAt !== 'review'
      ? 'A refused completion prerequisite cannot be accepted. Send it back once it is fixed, or close it.'
      : run.engineState?.publishGate?.humanPublicationAdoption?.id !== adopted.receiptId ||
          (run.engineState?.generation ?? 0) !== adopted.generation
        ? 'The run changed since the publication was adopted. Refresh the run.'
        : undefined;
  return unavailableReason
    ? { id: 'accept-result', available: false, unavailableReason, requiresReason: true }
    : { id: 'accept-result', available: true, requiresReason: true };
}

/** Settle a held run through one result-decision action (ADR-065 Amendment 7). */
export async function resolveResultDecision(
  params: ResolveResultDecisionParams,
  options: {
    releaseSlot?: boolean;
    adoptedPublication?: AdoptedPublicationAcceptance;
    /** The engine's one automatic send-back for stale CI receipts. */
    staleReceiptSendBack?: true;
  } = {},
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
            ? options.adoptedPublication
              ? adoptedAcceptState(run, payload.stoppedAt, options.adoptedPublication)
              : acceptState(run, payload.stoppedAt)
            : { id: actionId, available: true, requiresReason: false };
      if (!state.available) throw new Error(state.unavailableReason ?? 'Action unavailable');
      if (actionId === 'send-back' && payload.stoppedAt === 'review') {
        resume = recordedReviewResult(
          run.steps.find((step) => step.name === PipelineSteps.REVIEW)?.outputs,
        );
        if (!resume && !reviewBudgetStopReason(run))
          throw new Error('The recorded review cannot be resumed. Accept or close the result.');
      }
      if (actionId === 'accept-result' && !reason)
        throw new Error('Accepting a result needs a written reason.');
      if (actionId !== 'send-back' && options.releaseSlot !== false && run.slotId) {
        const before = await readSlotRow(run.slotId);
        // An already released source may now belong to someone else. Never acquire from it.
        if (ownsRunSlotCleanup(before, run.id)) {
          await retainFinalRunArtifacts(run.id);
          const after = await readSlotRow(run.slotId);
          if (!ownsRunSlotCleanup(after, run.id) || after?.slot_epoch !== before?.slot_epoch)
            throw new Error('Slot ownership changed while retaining the final result.');
          // An earlier queued mirror capture can supersede the judged output while this waits.
          const current = getRun(run.id);
          if (
            !current ||
            pendingResultDecision(current)?.id !== decision.id ||
            pendingOutputReview(current)?.id !== payload.outputReviewDecisionId
          )
            throw new StaleResultDecisionError();
        }
      }
      const now = new Date().toISOString();
      const receipt = {
        action: actionId,
        principalId:
          options.adoptedPublication?.principalId ?? currentSessionPrincipal()?.id ?? 'system',
        ...(reason ? { reason } : {}),
        decidedAt: now,
        delivered: payload.delivered,
        findingsDigest: payload.findingsDigest,
      };
      const { bumpRunGeneration, cancelRunEngine } = await import('../run-engine/orchestrator.js');
      // After the last await: the adopted receipt and generation still hold for this decision.
      const adopted = options.adoptedPublication;
      if (adopted) {
        const latest = getRun(params.runId);
        if (
          !latest ||
          pendingResultDecision(latest)?.id !== decision.id ||
          !adoptedAcceptState(latest, payload.stoppedAt, adopted).available
        )
          throw new Error('The run changed since the publication was adopted. Refresh the run.');
      }
      cancelRunEngine(params.runId);
      const settledGeneration = bumpRunGeneration(params.runId);
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
          ...(options.staleReceiptSendBack
            ? {
                engineState: {
                  ...getRun(params.runId)?.engineState,
                  staleReceiptSendBack: { decisionId: decision.id, sentAt: now },
                },
              }
            : {}),
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
          // An adoption-bound acceptance rechecks its receipt at the mutation boundary.
          ...(options.adoptedPublication
            ? {
                before: [
                  {
                    name: 'adopted-publication-current',
                    severity: 'required' as const,
                    apply: ({ run: latest }: { run: Run }) => {
                      if (
                        pendingResultDecision(latest)?.id !== decision.id ||
                        latest.engineState?.publishGate?.humanPublicationAdoption?.id !==
                          options.adoptedPublication!.receiptId ||
                        (latest.engineState?.generation ?? 0) !== settledGeneration
                      )
                        throw new Error(
                          'The run changed since the publication was adopted. Refresh the run.',
                        );
                    },
                  },
                ],
              }
            : {}),
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

/** Every refused prerequisite is a stale CI receipt. */
function onlyStaleReceipts(reasons: readonly RunGatePrerequisiteReason[] | undefined): boolean {
  return (
    Boolean(reasons?.length) && reasons!.every((reason) => reason.code === 'deterministic-stale')
  );
}

/** A COMPLETE refusal whose every owed check is a stale CI receipt. */
function staleReceiptRefusal(decision: RunDecision): boolean {
  const payload = decision.payload;
  return (
    payload?.kind === 'result-decision' &&
    payload.stoppedAt === 'complete' &&
    onlyStaleReceipts(payload.refusal?.reasons)
  );
}

/** COMPLETE's recorded refusal will be sent back at once: its hold needs no card. */
export function staleReceiptSendBackDue(run: Run): boolean {
  return (
    !run.engineState?.staleReceiptSendBack && onlyStaleReceipts(refusal(run, 'complete')?.reasons)
  );
}

/**
 * A stale CI receipt is the worker's to rerun: a held run sends it back once with the
 * steps to mark again, and any later stale refusal waits for a person (961d55d3).
 * The marker lives in engineState because a completion replay drops resolved decisions.
 * Returns false only when its decision is still pending unannounced: a send-back that
 * failed after resolving re-holds and announces on its own.
 */
export async function sendBackStaleReceiptOnce(run: Run): Promise<boolean> {
  const decision = pendingResultDecision(run);
  if (!decision || !staleReceiptRefusal(decision) || run.engineState?.staleReceiptSendBack)
    return false;
  try {
    // The engine decides this, not the person whose session started the run.
    await runWithSystemOriginator(() =>
      resolveResultDecision(
        { runId: run.id, decisionId: decision.id, actionId: 'send-back' },
        { staleReceiptSendBack: true },
      ),
    );
    return true;
  } catch (error) {
    console.warn(
      `[result-decision] automatic send-back for ${run.id.slice(0, 8)} did not complete: ${(error as Error).message}`,
    );
    return pendingResultDecision(getRun(run.id) ?? run)?.id !== decision.id;
  }
}

/** Announce the run's pending result decision, after a quiet hold the engine did not settle. */
export async function announcePendingResultDecision(runId: string): Promise<void> {
  const run = getRun(runId);
  const decision = run && pendingResultDecision(run);
  if (run && decision) await publishDecision(run, decision);
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
      // An instruction the worker already has cannot be un-sent. Re-presenting
      // the refusal it is acting on is what run 1ad82ba1 (audiolab#526) did: the
      // same stale decision came back 6 s later, and because monitoring never
      // resumed, the worker's corrected signal 7 minutes later was never read —
      // the lead recovered it by replaying monitor by hand. So that is what the
      // engine does now: resume monitoring and let the worker's next signal
      // settle it, instead of holding the old refusal again.
      // `sendBackCompletion` resumes monitoring itself for an instruction the
      // worker may already have, under its own ownership checks. The run is
      // monitoring again, so it must not be held on the refusal it just left.
      // Only a plain delivery error means the resume succeeded. An AggregateError
      // is `sendBackCompletion` reporting that it could NOT resume, so the run
      // must be held again: round 10 found that treating it as resumed left the
      // operator with neither a decision nor a Replay action.
      const { CompletionFeedbackDeliveryError } = await import('./completion-send-back.js');
      if (error instanceof CompletionFeedbackDeliveryError && error.handedOver) throw error;
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

async function releaseSettledSlot(run: Run, discard: boolean): Promise<void> {
  try {
    if (discard) {
      // Close of a retained refused completion is the Amendment 6 named discard.
      const { slotRelease } = await import('../methods/slot/release.js');
      const { broadcastEvent } = await import('../server.js');
      const { released } = await slotRelease(
        { slotId: run.slotId!, forceReset: true, expectedRunId: run.id },
        broadcastEvent,
      );
      // COMPLETE may already have released the slot; its kept checkout still returns to idle.
      if (!released) {
        const { returnReleasedCheckoutToIdle } = await import('../run-lifecycle/safe-idle-slot.js');
        const result = await returnReleasedCheckoutToIdle(getRun(run.id) ?? run, broadcastEvent);
        if (result && result.kind !== 'ready')
          await persistRunNow(
            updateRun(run.id, { slotTeardownSkipped: `Checkout retained: ${result.reason}` }),
            'released checkout retained',
          );
      }
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
