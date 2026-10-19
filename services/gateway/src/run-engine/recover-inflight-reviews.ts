// recover-inflight-reviews.ts — Recover completed reviews whose
// result was lost to a gateway restart mid-`executeReview` await.
//
// A publish-gate review spawns a reviewer runner and awaits its
// completion inside `executeReview`. If the gateway restarts during that
// await, the reviewer keeps running on its own tmux window and writes its
// feedback + terminal signal, but the awaiting call never returns — the result
// never reaches `publishGate.reviews`, and because the human gate
// already cleared `reviewSequence`, the review is not re-run. The gate then
// re-presents as if no review happened, discarding a completed (often ~40 min)
// review.
//
// `recoverReviewFixPass` covers the mirror case for an in-flight FIX pass.
// This module covers the review pass: on human-gate re-entry, scan the run's
// persisted reviewer contexts for a completed signal + feedback and ingest the
// verdict into `reviews`, mirroring fix-pass recovery.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  type AgentContext,
  type ReadyGatePrPackage,
  type ReviewDiffSnapshot,
  reviewFixRetriesExhausted,
  type ReviewStatus,
  type Run,
  type WorkerSignal,
} from '@farmslot/protocol';
import { resolveReviewMode } from '@farmslot/review-dispatch';

import { upsertAgentContext } from '../agents/contexts.js';
import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { slotCopyFile } from '../core/slot-io.js';
import { shellQuote } from '../core/tmux.js';
import { REQUESTED_REVIEW_SOURCE } from '../quality/review-sources.js';
import { readReviewFeedback } from '../review/feedback.js';
import type { ReviewResult } from '../review/orchestrator.js';
import {
  persistReviewOutputArtifacts,
  resumeReviewAgentPromptDelivery,
  reviewerFeedbackRelPath,
} from '../review/review-agent.js';
import {
  reviewRoundAdmissionId,
  settleReviewRoundNoVerdict,
} from '../review/review-round-budget.js';
import { recordReviewedInputs } from '../review/reviewed-inputs.js';
import { readPersistedReviewSnapshot, reviewArtifactDir } from '../review/snapshots.js';
import { getReviewConfig } from '../review/templates.js';
import {
  isSuccessfulTerminalReviewSignal,
  isTerminalReviewArtifactError,
  reviewResultArtifactPath,
  TerminalReviewArtifactError,
} from '../review/terminal-result.js';
import { getRun, updateRun } from '../runs/store.js';
import { signalFreshSince, terminalWorkerSignalFromRaw } from '../tasks/worker-signals.js';

import {
  buildPublishGateReviewStatus,
  normalizeExhaustedReviewContinuation,
  pendingReviewContinuation,
  reviewNeedsContinuation,
} from './gate-policy.js';
import { persistReviewArtifactsForRun, readPreparedPackage } from './ready-gate.js';
import { copyWorkerArtifacts } from './review-artifacts.js';
import { reviewerContextEffort } from './review-plan.js';

export { isTerminalReviewArtifactError, TerminalReviewArtifactError };

export interface PublicationReviewRecoveryResult {
  recoveredIds: string[];
  repairedIds?: string[];
  relaunchIds?: string[];
  terminalErrors: Array<{ contextId: string; message: string }>;
}

/** Recover the operator gate even when a prior poll already ingested its findings. */
export function publicationReviewRecoveryNeedsReplay(
  result: PublicationReviewRecoveryResult,
  reviews: ReviewStatus[] = [],
): boolean {
  return (
    result.recoveredIds.length > 0 ||
    (result.repairedIds?.length ?? 0) > 0 ||
    (result.relaunchIds?.length ?? 0) > 0 ||
    pendingReviewContinuation(reviews) !== undefined
  );
}

type RecoveredReviewerAction =
  | { kind: 'recovered'; id: string }
  | { kind: 'repaired'; id: string }
  | { kind: 'relaunch'; id: string }
  | null;

export function recoveredReviewerActionForPromptRecovery(
  promptRecovery: Awaited<ReturnType<typeof resumeReviewAgentPromptDelivery>>,
  ctx: Pick<AgentContext, 'id' | 'artifactScope'>,
): RecoveredReviewerAction {
  return promptRecovery === 'retired'
    ? { kind: 'relaunch', id: ctx.artifactScope?.trim() || ctx.id }
    : null;
}

interface PublicationReviewRecoveryOptions {
  shouldAbort?: () => boolean;
  captureArtifacts?: typeof copyWorkerArtifacts;
  readers?: {
    slot?: typeof loadSlotVars;
    config?: typeof getReviewConfig;
    package?: typeof readPreparedPackage;
  };
}

async function markRecoveredReviewerContext(
  runId: string,
  ctx: AgentContext,
  status: 'complete' | 'failed' | 'blocked',
  patch: Partial<AgentContext>,
): Promise<boolean> {
  const completedAt = new Date().toISOString();
  const updated = await upsertAgentContext(
    runId,
    'review',
    { id: ctx.id },
    {
      resolvePatch: (current) => {
        if (
          !current ||
          current.attemptStartedAt !== ctx.attemptStartedAt ||
          current.signalAttemptId !== ctx.signalAttemptId
        ) {
          return null;
        }
        return { id: ctx.id, status, completedAt, ...patch };
      },
    },
  );
  return updated !== null;
}

// The native reviewer admitted its round under its context's launch time.
async function settleRecoveredReviewerNoVerdict(
  runId: string,
  ctx: AgentContext,
  reason: string,
): Promise<void> {
  if (!ctx.startedAt) return;
  await settleReviewRoundNoVerdict(
    runId,
    reviewRoundAdmissionId(ctx.reviewId ?? ctx.id, ctx.reviewLoopNumber ?? 1, ctx.startedAt),
    reason,
  );
}

function signalMatchesReviewerAttempt(signal: WorkerSignal, ctx: AgentContext): boolean {
  if (ctx.signalAttemptId) return signal.attemptId === ctx.signalAttemptId;
  return signalFreshSince(signal, ctx.attemptStartedAt ?? ctx.startedAt);
}

function completedReviewerContextIsFresh(
  ctx: AgentContext,
  signal: WorkerSignal | undefined,
): boolean {
  if (ctx.signalAttemptId && signal && signal.attemptId !== ctx.signalAttemptId) return false;
  const freshnessAnchor = ctx.attemptStartedAt ?? ctx.startedAt;
  return (
    ctx.status === 'complete' &&
    !!ctx.completedAt &&
    (!freshnessAnchor || Date.parse(ctx.completedAt) >= Date.parse(freshnessAnchor))
  );
}

/**
 * A reviewer context can need recovery while in-flight or after its runner was
 * reconciled to `complete`. A failed context is eligible only when the caller
 * explicitly includes it; `reviewerContextNeedsRecovery` then requires the
 * matching persisted delivery-failure placeholder, so a real terminal failure
 * cannot keep the six-hour watcher alive. A blocked context is eligible only
 * for explicit recovery passes: the reviewer may have finished after the gate
 * rejected its still-missing result artifact.
 */
export function isRecoverableReviewerContext(
  ctx: Pick<AgentContext, 'role' | 'status'>,
  options: { includeFailed?: boolean; includeBlocked?: boolean } = {},
): boolean {
  return (
    ctx.role === 'review' &&
    (ctx.status === 'working' ||
      ctx.status === 'launching' ||
      ctx.status === 'complete' ||
      (options.includeFailed === true && ctx.status === 'failed') ||
      (options.includeBlocked === true && ctx.status === 'blocked'))
  );
}

function isFailedReviewPlaceholder(
  review: Pick<
    ReviewStatus,
    'verdict' | 'unresolvedCount' | 'feedbackSent' | 'recoveryContinuationPending'
  >,
): boolean {
  return (
    review.verdict === 'failed' &&
    review.unresolvedCount === 0 &&
    review.feedbackSent !== true &&
    review.recoveryContinuationPending === true
  );
}

function hasLaterSettledReview(reviews: RecoverableReviewRecord[], recordedIndex: number): boolean {
  return reviews
    .slice(recordedIndex + 1)
    .some(
      (review) =>
        (review.verdict === 'pass' || review.verdict === 'issues') &&
        review.unresolvedCount !== undefined,
    );
}

type RecoverableReviewRecord = Pick<ReviewStatus, 'id'> &
  Partial<
    Pick<
      ReviewStatus,
      | 'source'
      | 'verdict'
      | 'unresolvedCount'
      | 'feedbackSent'
      | 'recoveryContinuationPending'
      | 'issues'
      | 'retryCount'
      | 'maxRetries'
      | 'maxRetriesExhausted'
      | 'attempts'
      | 'artifactPaths'
      | 'reviewSnapshot'
      | 'reviewerSessionId'
      | 'reviewedHeadSha'
      | 'startedAt'
    >
  >;

type RecoveryContext = Pick<
  AgentContext,
  'role' | 'status' | 'artifactScope' | 'reviewResultFile' | 'runnerSessionId' | 'attemptStartedAt'
>;

/** Repair only a completed attempt's missing evidence, never reopen a different review. */
export function recoveredReviewNeedsArtifactRepair(
  ctx: RecoveryContext,
  review: RecoverableReviewRecord,
): boolean {
  return (
    ctx.role === 'review' &&
    ctx.status === 'complete' &&
    !!ctx.reviewResultFile?.trim() &&
    !!ctx.runnerSessionId &&
    !!ctx.attemptStartedAt &&
    ctx.artifactScope?.trim() === review.id &&
    review.reviewerSessionId === ctx.runnerSessionId &&
    (review.attempts?.at(-1)?.startedAt ?? review.startedAt) === ctx.attemptStartedAt &&
    (review.verdict === 'pass' || review.verdict === 'issues') &&
    (!review.reviewSnapshot || !reviewResultArtifactPath(review))
  );
}

export function reviewerContextNeedsRecovery(
  ctx: RecoveryContext,
  reviews: RecoverableReviewRecord[],
  options: { includeFailed?: boolean; includeBlocked?: boolean } = {},
): boolean {
  if (!isRecoverableReviewerContext(ctx, options)) return false;
  const artifactScope = ctx.artifactScope?.trim();
  // Without a persisted scope, complete contexts may already be ingested and
  // failed contexts cannot match a delivery-failure placeholder. In-flight
  // contexts remain recoverable via the existing fallback id path.
  if (!artifactScope) return ctx.status !== 'complete' && ctx.status !== 'failed';
  const recordedIndex = reviews.findIndex((review) => review.id === artifactScope);
  if (recordedIndex < 0) return ctx.status !== 'failed';
  const recorded = reviews[recordedIndex];
  if (
    !hasLaterSettledReview(reviews, recordedIndex) &&
    recoveredReviewNeedsArtifactRepair(ctx, recorded)
  )
    return true;
  if (
    ctx.status !== 'failed' &&
    recorded.source !== undefined &&
    recorded.verdict !== undefined &&
    recorded.unresolvedCount !== undefined &&
    !hasLaterSettledReview(reviews, recordedIndex) &&
    reviewNeedsContinuation({
      source: recorded.source,
      verdict: recorded.verdict,
      feedbackSent: recorded.feedbackSent,
      recoveryContinuationPending: recorded.recoveryContinuationPending,
      unresolvedCount: recorded.unresolvedCount,
      issues: recorded.issues,
      retryCount: recorded.retryCount,
      maxRetries: recorded.maxRetries,
      maxRetriesExhausted: recorded.maxRetriesExhausted,
      attempts: recorded.attempts,
    })
  ) {
    return true;
  }
  if (
    ctx.status !== 'failed' &&
    recorded.verdict === 'skipped' &&
    !hasLaterSettledReview(reviews, recordedIndex)
  ) {
    return true;
  }
  return (
    !hasLaterSettledReview(reviews, recordedIndex) &&
    recorded.verdict !== undefined &&
    recorded.unresolvedCount !== undefined &&
    isFailedReviewPlaceholder({
      verdict: recorded.verdict,
      unresolvedCount: recorded.unresolvedCount,
      feedbackSent: recorded.feedbackSent,
      recoveryContinuationPending: recorded.recoveryContinuationPending,
    })
  );
}

/**
 * A non-terminal reviewer context is only live while its artifact scope still
 * needs recovery. Once that review is terminal, or a later review has already
 * been persisted, keeping the old context `working` creates a ghost reviewer in
 * the run/slot UI and makes restart recovery revisit work that has settled.
 */
export function reviewerContextIsSettled(
  ctx: Pick<AgentContext, 'role' | 'status' | 'artifactScope'>,
  reviews: RecoverableReviewRecord[],
): boolean {
  if (ctx.role !== 'review' || (ctx.status !== 'working' && ctx.status !== 'launching')) {
    return false;
  }
  const artifactScope = ctx.artifactScope?.trim();
  if (!artifactScope) return false;
  const recordedIndex = reviews.findIndex((review) => review.id === artifactScope);
  if (recordedIndex < 0) return false;
  if (!reviewerContextNeedsRecovery(ctx, reviews)) return true;
  return hasLaterSettledReview(reviews, recordedIndex);
}

/**
 * Build the `ReviewStatus` for a recovered reviewer, or `null` when
 * the reviewer has not actually finished (no fresh terminal signal or completed
 * runtime context, or feedback that never parsed into a verdict). Pure so the
 * recovery decision is unit testable without slot I/O.
 *
 * `signalFreshSince(signal, ctx.attemptStartedAt ?? ctx.startedAt)` rejects a
 * stale signal left by an earlier loop — anchored on the current attempt's
 * launch time, which survives both warm context reuse and the updatedAt
 * rewrite that startup reconciliation performs before recovery runs.
 *
 * When `reviewedPackage` is supplied the review is stamped against it (HEAD +
 * subject hashes), matching how a live review certifies its package. The caller
 * passes it only when the slot HEAD still matches the package, so a recovered
 * PASS never certifies code that changed after the review.
 */
export function buildRecoveredReview(params: {
  run: Run;
  ctx: AgentContext;
  signal: WorkerSignal | undefined;
  feedback: Pick<
    Awaited<ReturnType<typeof readReviewFeedback>>,
    'verdict' | 'issues' | 'validationDepth' | 'incomplete'
  >;
  reviewSnapshot?: ReviewDiffSnapshot;
  reviewedPackage: ReadyGatePrPackage | undefined;
  recoveryContinuationPending?: boolean;
}): ReviewStatus | null {
  const { run, ctx, signal, feedback, reviewSnapshot, reviewedPackage } = params;
  // Freshness anchors on the CURRENT attempt's launch time. startedAt is too
  // old for warm-reused contexts (they keep loop 1's value, so a prior loop's
  // signal looks fresh) and updatedAt is too new after a restart (startup
  // reconciliation rewrites it before this recovery runs, which would reject
  // the genuine pre-restart signal this path exists to ingest).
  const freshSignal = signal && signalMatchesReviewerAttempt(signal, ctx) ? signal : undefined;
  const completedContextIsFresh = completedReviewerContextIsFresh(ctx, signal);
  if (!freshSignal && !completedContextIsFresh) return null;
  // Only a cleanly completed reviewer may stamp a verdict. A failed/blocked
  // terminal signal can coexist with parseable feedback (e.g. a PASS draft
  // written before the reviewer died) — stamping it would certify a review
  // that never finished; skipping leaves the gate to request a fresh one.
  if (freshSignal && freshSignal.status !== 'complete' && freshSignal.status !== 'done')
    return null;
  if (feedback.incomplete) return null;

  const priorReviews = run.engineState?.publishGate?.reviews ?? [];
  const reviewId = recoveredReviewArtifactScope(
    ctx,
    REQUESTED_REVIEW_SOURCE.artifactRefs(priorReviews.length + 1).id,
  );
  const reviewResult: ReviewResult = {
    verdict: feedback.verdict,
    issues: feedback.issues,
    validationDepth: feedback.validationDepth,
    runner: ctx.runner ?? undefined,
    model: ctx.model ?? undefined,
    effort: reviewerContextEffort(ctx),
    retryCount: 0,
    reviewSnapshot,
    reviewId: ctx.reviewId,
    reviewerSessionId: ctx.runnerSessionId ?? undefined,
    mode: resolveReviewMode({
      explicitMode: priorReviews.find((review) => review.id === reviewId)?.mode,
    }),
    session: priorReviews.find((review) => review.id === reviewId)?.session,
    attempts: [
      {
        loopNumber: 1,
        mode: resolveReviewMode({ run }),
        verdict: feedback.verdict,
        unresolvedCount: feedback.verdict === 'pass' ? 0 : feedback.issues.length,
        ...(feedback.issues.length ? { issues: feedback.issues } : {}),
        validationDepth: feedback.validationDepth,
        reviewSnapshot,
        startedAt: ctx.attemptStartedAt ?? ctx.startedAt,
        completedAt: freshSignal?.timestamp ?? ctx.completedAt,
      },
    ],
  };
  const recovered = buildPublishGateReviewStatus({
    source:
      run.engineState?.publishGate?.reviewPolicy?.requestedBy === 'dispatch'
        ? 'dispatch'
        : 'human-gate',
    priorReviewCount: priorReviews.length,
    reviewResult,
    requestedRunner: ctx.runner ?? null,
    model: ctx.model ?? run.metrics.actualModel ?? run.metrics.model ?? null,
    effort: reviewerContextEffort(ctx),
    reviewId,
    reviewedPackage: reviewedPackage ?? null,
  });
  return {
    ...recovered,
    recoveryContinuationPending:
      feedback.verdict === 'issues' && params.recoveryContinuationPending === true,
    startedAt: ctx.attemptStartedAt ?? ctx.startedAt ?? recovered.startedAt,
    completedAt: freshSignal?.timestamp ?? ctx.completedAt ?? recovered.completedAt,
  };
}

async function readRecoveredReviewSnapshot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  ctx: AgentContext,
  reviewId: string,
) {
  const directory = path.posix.isAbsolute(taskDir) ? taskDir : `${vars.remoteRepo}/${taskDir}`;
  const scopes: Array<string | undefined> = [ctx.artifactScope?.trim() || reviewId];
  // Older pipeline contexts had no scope until recovery assigned their review id.
  // Read their recorded loop, never whichever historical file has the newest mtime.
  if (!ctx.artifactScope || ctx.reviewId?.startsWith('pipeline-review-')) scopes.push(undefined);
  for (const scope of scopes) {
    const captured = await readPersistedReviewSnapshot(
      vars,
      directory,
      ctx.reviewLoopNumber ?? 1,
      scope,
    );
    if (captured) return captured;
  }
  return undefined;
}

export function recoveredReviewArtifactScope(
  context: Pick<AgentContext, 'artifactScope'>,
  fallbackReviewId: string,
): string {
  return context.artifactScope?.trim() || fallbackReviewId;
}

async function readReviewerTerminalSignal(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  ctx: AgentContext,
): Promise<WorkerSignal | undefined> {
  if (!ctx.signalFile) return undefined;
  const raw = (
    await execOnSlot(vars, `cat ${shellQuote(`${vars.remoteRepo}/${ctx.signalFile}`)} 2>/dev/null`)
  ).stdout.trim();
  try {
    return terminalWorkerSignalFromRaw(raw);
  } catch (err) {
    // A malformed signal file means "no trustworthy terminal signal yet" — the
    // caller then treats the reviewer as unfinished and skips it, which is the
    // safe outcome (never ingest a review we cannot confirm completed).
    console.warn(
      `[run-engine] ignoring invalid recovered reviewer signal for ${ctx.id}: ${(err as Error).message}`,
    );
    return undefined;
  }
}

async function readSlotHeadSha(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
): Promise<string | null> {
  try {
    const sha = (
      await execOnSlot(vars, `git -C ${shellQuote(vars.remoteRepo)} rev-parse HEAD 2>/dev/null`, {
        timeout: 15_000,
      })
    ).stdout.trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } catch (err) {
    // HEAD is only used to decide whether a recovered review may be stamped
    // against the prepared package. A failed probe returns null → the review is
    // left unstamped (stale) → a fresh review is forced. Fail safe, never certify.
    console.warn(
      `[run-engine] recovered-review HEAD probe failed: ${(err as Error).message.slice(0, 200)}`,
    );
    return null;
  }
}

/**
 * Ingest any completed-but-lost publication reviews for a run into
 * `publishGate.reviews`. Idempotent: complete contexts are matched to
 * their persisted artifact scope, while in-flight contexts are flipped to
 * `complete` on ingest. Returns the ids of the reviews it recovered.
 */
export async function recoverInflightPublicationReviews(
  runId: string,
  slotId: string,
  options: PublicationReviewRecoveryOptions = {},
): Promise<PublicationReviewRecoveryResult> {
  if (options.shouldAbort?.()) return { recoveredIds: [], terminalErrors: [] };
  let run = getRun(runId);
  if (!run) return { recoveredIds: [], terminalErrors: [] };
  let reviews = run.engineState?.publishGate?.reviews ?? [];
  const settledContexts = (run.agentContexts ?? []).filter((ctx) =>
    reviewerContextIsSettled(ctx, reviews),
  );
  if (settledContexts.length > 0) {
    for (const ctx of settledContexts) {
      if (options.shouldAbort?.()) break;
      await markRecoveredReviewerContext(runId, ctx, 'complete', {});
    }
  }
  if (settledContexts.length > 0) {
    console.log(
      `[run-engine] run ${runId.slice(0, 8)} — settled ${settledContexts.length} superseded reviewer context(s)`,
    );
    run = getRun(runId);
    if (!run) return { recoveredIds: [], terminalErrors: [] };
    reviews = run.engineState?.publishGate?.reviews ?? [];
  }
  const candidates = (run.agentContexts ?? []).filter((ctx) =>
    reviewerContextNeedsRecovery(ctx, reviews, { includeFailed: true, includeBlocked: true }),
  );
  if (candidates.length === 0) return { recoveredIds: [], terminalErrors: [] };
  const vars = await (options.readers?.slot ?? loadSlotVars)(slotId);

  const reviewConfig = await (options.readers?.config ?? getReviewConfig)(run.project);
  const recoveryContinuationPending = Math.max(0, reviewConfig.max_retries ?? 1) > 0;
  const reviewedPackage = await (options.readers?.package ?? readPreparedPackage)(run);
  // Stamp recovered reviews against the prepared package only when the slot HEAD
  // still matches it — a lost review certifies the HEAD it saw, and at the human
  // gate the worker is idle so an unchanged HEAD proves the reviewer saw exactly
  // this package. If HEAD drifted, leave the review unstamped (stale) so a real
  // code change forces a fresh review rather than a false certification.
  const currentHead = await readSlotHeadSha(vars);
  const stampablePackage =
    reviewedPackage && currentHead && currentHead === reviewedPackage.headSha
      ? reviewedPackage
      : undefined;

  const recoveredIds: string[] = [];
  const repairedIds: string[] = [];
  const relaunchIds: string[] = [];
  const terminalErrors: PublicationReviewRecoveryResult['terminalErrors'] = [];
  for (const ctx of candidates) {
    if (options.shouldAbort?.()) break;
    try {
      const action = await ingestRecoveredReviewer(
        runId,
        vars,
        ctx,
        stampablePackage,
        recoveryContinuationPending,
        options,
      );
      if (action?.kind === 'recovered') recoveredIds.push(action.id);
      if (action?.kind === 'repaired') repairedIds.push(action.id);
      if (action?.kind === 'relaunch') relaunchIds.push(action.id);
    } catch (err) {
      if (isTerminalReviewArtifactError(err)) {
        terminalErrors.push({ contextId: ctx.id, message: err.message });
        continue;
      }
      // One unreadable reviewer (corrupt signal/feedback file, transient slot
      // read error) must not strand the human gate or block recovery of the
      // other reviewers — mirror executePublishGateReviewPlan, which degrades a
      // failed review to a recorded outcome rather than throwing out of the gate.
      console.warn(
        `[run-engine] run ${runId.slice(0, 8)} — recovering reviewer ${ctx.id} failed, skipping: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }
  return { recoveredIds, repairedIds, relaunchIds, terminalErrors };
}

/**
 * Ingest a single recoverable reviewer context. Returns the recovered review id,
 * or `null` when the reviewer has not finished (no fresh terminal signal, or
 * feedback that never parsed into a verdict).
 */
async function ingestRecoveredReviewer(
  runId: string,
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  ctx: AgentContext,
  stampablePackage: ReadyGatePrPackage | undefined,
  recoveryContinuationPending: boolean,
  options: PublicationReviewRecoveryOptions,
): Promise<RecoveredReviewerAction> {
  const signal = await readReviewerTerminalSignal(vars, ctx);
  if (options.shouldAbort?.()) return null;
  const freshSignal = signal && signalMatchesReviewerAttempt(signal, ctx) ? signal : undefined;
  if (freshSignal && !isSuccessfulTerminalReviewSignal(freshSignal)) {
    const persistedId = await persistRecoveredFailedReviewer(
      runId,
      ctx,
      freshSignal,
      stampablePackage,
      options,
    );
    return persistedId ? { kind: 'recovered', id: persistedId } : null;
  }
  if (!freshSignal && (ctx.status === 'working' || ctx.status === 'launching')) {
    const promptRecovery = await resumeReviewAgentPromptDelivery(vars, runId, ctx);
    if (options.shouldAbort?.()) return null;
    if (promptRecovery === 'inactive' || promptRecovery === 'retired') {
      const contextSettled = await markRecoveredReviewerContext(runId, ctx, 'failed', {});
      if (!contextSettled) return null;
      await settleRecoveredReviewerNoVerdict(runId, ctx, 'lost on restart');
      const action = recoveredReviewerActionForPromptRecovery(promptRecovery, ctx);
      if (action) return action;
    } else if (promptRecovery === 'unsupported') {
      console.warn(
        `[run-engine] run ${runId.slice(0, 8)} — reviewer ${ctx.id} cannot resume prompt delivery; marking it failed`,
      );
      if (await markRecoveredReviewerContext(runId, ctx, 'failed', {}))
        await settleRecoveredReviewerNoVerdict(runId, ctx, 'lost on restart');
    }
    return null;
  }
  // The reviewer's task dir is encoded in its stored task file path; feedback
  // is scoped to the reviewer's context id alongside it.
  const taskDir = ctx.taskFile ? path.posix.dirname(ctx.taskFile) : null;
  if (!taskDir) return null;
  const feedback = await readReviewFeedback(
    vars,
    taskDir,
    reviewerFeedbackRelPath(ctx.id),
    ctx.reviewResultFile,
  );
  if (options.shouldAbort?.()) return null;
  const completedContextIsFresh = completedReviewerContextIsFresh(ctx, signal);
  if (
    (isSuccessfulTerminalReviewSignal(freshSignal) || completedContextIsFresh) &&
    feedback.terminalInvalidReason
  ) {
    if (ctx.status === 'blocked') return null;
    if (options.shouldAbort?.()) return null;
    const contextSettled = await markRecoveredReviewerContext(runId, ctx, 'blocked', {});
    if (!contextSettled) return null;
    await settleRecoveredReviewerNoVerdict(runId, ctx, feedback.terminalInvalidReason);
    throw new TerminalReviewArtifactError(
      `Reviewer ${ctx.id} completed with an invalid result artifact: ${feedback.terminalInvalidReason}`,
    );
  }

  const latest = getRun(runId)!;
  if (!latest.taskFile) return null;
  const priorReviews = latest.engineState?.publishGate?.reviews ?? [];
  const reviewId = REQUESTED_REVIEW_SOURCE.artifactRefs(priorReviews.length + 1).id;
  const artifactScope = recoveredReviewArtifactScope(ctx, reviewId);
  if (!ctx.artifactScope?.trim()) {
    console.warn(
      `[run-engine] recovered reviewer ${ctx.id} has no persisted artifact scope; falling back to ${artifactScope}`,
    );
  }
  const snapshotCapture = await readRecoveredReviewSnapshot(vars, taskDir, ctx, artifactScope);
  const reviewSnapshot = snapshotCapture?.snapshot;
  if (options.shouldAbort?.()) return null;
  const review = buildRecoveredReview({
    run: latest,
    ctx,
    signal,
    feedback,
    reviewSnapshot,
    reviewedPackage: stampablePackage,
    recoveryContinuationPending,
  });
  if (!review) return null;

  const existingReview = priorReviews.find((candidate) => candidate.id === review.id);
  const repairing = existingReview
    ? recoveredReviewNeedsArtifactRepair(ctx, existingReview)
    : false;
  if (existingReview && !repairing && recoveredReviewAlreadyIngested(existingReview, review))
    return null;
  if (
    existingReview &&
    !repairing &&
    !isFailedReviewPlaceholder(existingReview) &&
    existingReview.verdict !== 'skipped' &&
    !reviewNeedsContinuation(existingReview)
  ) {
    return null;
  }
  const recovered = existingReview
    ? repairing
      ? repairRecoveredReviewArtifacts(existingReview, review)
      : appendRecoveredContinuationAttempt(existingReview, review)
    : review;
  if (!recovered) return null;
  const output = await persistReviewOutputArtifacts({
    vars,
    taskDir,
    taskMdPath: ctx.taskFile!,
    signalBasename: path.posix.basename(ctx.signalFile ?? ''),
    feedbackRelPath: reviewerFeedbackRelPath(ctx.id),
    resultRelPath: ctx.reviewResultFile,
    artifactDir: reviewArtifactDir(ctx.reviewLoopNumber ?? 1, artifactScope),
    feedbackIncomplete: false,
  });
  if (options.shouldAbort?.()) return null;
  const capturedPaths = [...(snapshotCapture?.artifactPaths ?? []), ...output.artifactPaths];
  // The general mirror excludes numeric review directories because the gateway
  // owns them. Transfer this exact recovery's named files before retaining them.
  const workerTaskDir = path.posix.isAbsolute(taskDir)
    ? taskDir
    : path.posix.join(vars.remoteRepo, taskDir);
  for (const relative of new Set(capturedPaths)) {
    if (!relative.startsWith('artifacts/') || path.posix.normalize(relative) !== relative)
      throw new Error(`Invalid recovered review artifact path: ${relative}`);
    const destination = path.join(path.dirname(latest.taskFile), relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await slotCopyFile(vars, path.posix.join(workerTaskDir, relative), destination, {
      phase: 'mirror',
      runId,
      slotId: vars.slotId,
      label: relative,
    });
    if (options.shouldAbort?.()) return null;
  }
  const reviewToPersist: ReviewStatus = {
    ...recovered,
    artifactPaths: [...new Set([...(recovered.artifactPaths ?? []), ...capturedPaths])],
    taskProgressArtifactPath: output.taskProgressArtifactPath,
    attempts: recovered.attempts?.map((attempt, index, attempts) =>
      index === attempts.length - 1
        ? {
            ...attempt,
            artifactPaths: [...new Set([...(attempt.artifactPaths ?? []), ...capturedPaths])],
            taskProgressArtifactPath: output.taskProgressArtifactPath,
          }
        : attempt,
    ),
  };
  const [persisted] = await persistReviewArtifactsForRun(latest, [reviewToPersist]);
  if (options.shouldAbort?.()) return null;
  // Startup consumes the recovery before replaying the gate. Retain its native
  // copies before committing a complete row, including when replay finds no new reviews.
  await (options.captureArtifacts ?? copyWorkerArtifacts)(runId);
  if (options.shouldAbort?.()) return null;
  const finalRun = getRun(runId)!;
  const finalReviews = finalRun.engineState?.publishGate?.reviews ?? [];
  const existingIndex = finalReviews.findIndex((candidate) => candidate.id === persisted.id);
  if (
    repairing &&
    (existingIndex < 0 || !isDeepStrictEqual(finalReviews[existingIndex], existingReview))
  )
    return null;
  if (
    existingIndex >= 0 &&
    !repairing &&
    recoveredReviewAlreadyIngested(finalReviews[existingIndex]!, persisted)
  ) {
    return null;
  }
  if (
    existingIndex >= 0 &&
    !repairing &&
    !isFailedReviewPlaceholder(finalReviews[existingIndex]!) &&
    finalReviews[existingIndex]!.verdict !== 'skipped' &&
    !reviewNeedsContinuation(finalReviews[existingIndex]!)
  ) {
    return null;
  }
  const nextReviews = [...finalReviews];
  if (existingIndex >= 0) nextReviews[existingIndex] = persisted;
  else nextReviews.push(persisted);
  if (options.shouldAbort?.()) return null;
  const contextSettled = await markRecoveredReviewerContext(runId, ctx, 'complete', {
    artifactScope,
    lastSignalAt: repairing ? ctx.lastSignalAt : new Date().toISOString(),
    ...(repairing && ctx.completedAt ? { completedAt: ctx.completedAt } : {}),
  });
  if (!contextSettled) return null;
  updateRun(runId, {
    engineState: {
      ...finalRun.engineState,
      publishGate: {
        ...finalRun.engineState?.publishGate,
        reviews: nextReviews,
      },
    },
  });
  // A recovered pass vouches for what its document gave the reviewer (F42).
  if (persisted.verdict === 'pass' && !repairing) await recordReviewedInputs(runId);
  console.log(
    `[run-engine] run ${runId.slice(0, 8)} — recovered in-flight publication review ${persisted.id} (verdict ${persisted.verdict}) from reviewer context ${ctx.id}`,
  );
  return { kind: repairing ? 'repaired' : 'recovered', id: persisted.id };
}

async function persistRecoveredFailedReviewer(
  runId: string,
  ctx: AgentContext,
  signal: WorkerSignal,
  reviewedPackage: ReadyGatePrPackage | undefined,
  options: PublicationReviewRecoveryOptions,
): Promise<string | null> {
  if (options.shouldAbort?.()) return null;
  const latest = getRun(runId)!;
  const priorReviews = latest.engineState?.publishGate?.reviews ?? [];
  const reviewId = recoveredReviewArtifactScope(
    ctx,
    REQUESTED_REVIEW_SOURCE.artifactRefs(priorReviews.length + 1).id,
  );
  const existingIndex = priorReviews.findIndex((review) => review.id === reviewId);
  const existing = existingIndex >= 0 ? priorReviews[existingIndex] : undefined;
  const validationDepth = existing?.validationDepth ?? 'full-live';
  const failed = buildPublishGateReviewStatus({
    source:
      latest.engineState?.publishGate?.reviewPolicy?.requestedBy === 'dispatch'
        ? 'dispatch'
        : 'human-gate',
    priorReviewCount: priorReviews.length,
    reviewResult: {
      verdict: 'blocked',
      reason: `reviewer-${signal.status}`,
      runner: ctx.runner ?? undefined,
      model: ctx.model ?? undefined,
      effort: reviewerContextEffort(ctx),
      retryCount: 0,
      validationDepth,
      attempts: [
        {
          loopNumber: 1,
          mode: resolveReviewMode({ explicitMode: existing?.mode }),
          verdict: 'failed',
          unresolvedCount: 0,
          validationDepth,
          startedAt: ctx.attemptStartedAt ?? ctx.startedAt,
          completedAt: signal.timestamp,
        },
      ],
    },
    requestedRunner: ctx.runner ?? null,
    model: ctx.model ?? latest.metrics.actualModel ?? latest.metrics.model ?? null,
    effort: reviewerContextEffort(ctx),
    reviewId,
    reviewedPackage: reviewedPackage ?? null,
  });
  const reviewToPersist = {
    ...(existing ? appendRecoveredContinuationAttempt(existing, failed) : failed),
    recoveryContinuationPending: false,
  };
  const [persisted] = await persistReviewArtifactsForRun(latest, [reviewToPersist]);
  if (options.shouldAbort?.()) return null;
  const nextReviews = [...priorReviews];
  if (existingIndex >= 0) nextReviews[existingIndex] = persisted;
  else nextReviews.push(persisted);
  if (options.shouldAbort?.()) return null;
  const contextSettled = await markRecoveredReviewerContext(
    runId,
    ctx,
    signal.status === 'blocked' ? 'blocked' : 'failed',
    { artifactScope: reviewId, lastSignalAt: signal.timestamp },
  );
  if (!contextSettled) return null;
  updateRun(runId, {
    engineState: {
      ...latest.engineState,
      publishGate: {
        ...latest.engineState?.publishGate,
        reviews: nextReviews,
      },
    },
  });
  await settleRecoveredReviewerNoVerdict(runId, ctx, `reviewer-${signal.status}`);
  console.log(
    `[run-engine] run ${runId.slice(0, 8)} — recovered terminal ${signal.status} publication review ${persisted.id} from reviewer context ${ctx.id}`,
  );
  return persisted.id;
}

/**
 * Repair and persist exhausted-loop continuations for a run's stored publish
 * gate reviews, returning the reviews the caller should act on. Shared by both
 * recovery entry points — human-gate re-entry and an operator review request —
 * so the read/normalize/persist shape stays defined once. Idempotent: a second
 * pass over already-normalized reviews persists nothing.
 */
/**
 * What normalizing WOULD produce, without writing it. Callers that must not
 * mutate the run until later refusals have passed project first and commit with
 * `normalizeExhaustedReviewContinuationsForRun` once they are past them.
 */
export function projectExhaustedReviewContinuationsForRun(runId: string): ReviewStatus[] {
  const run = getRun(runId);
  const storedReviews = run?.engineState?.publishGate?.reviews ?? [];
  if (!run) return storedReviews;
  return storedReviews.map(normalizeExhaustedReviewContinuation);
}

export function normalizeExhaustedReviewContinuationsForRun(runId: string): ReviewStatus[] {
  const run = getRun(runId);
  const storedReviews = run?.engineState?.publishGate?.reviews ?? [];
  if (!run) return storedReviews;
  const normalized = storedReviews.map(normalizeExhaustedReviewContinuation);
  if (!normalized.some((review, index) => review !== storedReviews[index])) return storedReviews;
  updateRun(runId, {
    engineState: {
      ...run.engineState,
      publishGate: {
        ...run.engineState?.publishGate,
        reviews: normalized,
      },
    },
  });
  console.log(
    `[run-engine] run ${runId.slice(0, 8)} — restored pending final findings from an exhausted review loop`,
  );
  return normalized;
}

/** Keep the original verdict, budget, timestamps and package attestation on evidence-only repair. */
export function repairRecoveredReviewArtifacts(
  existing: ReviewStatus,
  recovered: ReviewStatus,
): ReviewStatus | null {
  const snapshot = recovered.reviewSnapshot;
  if (
    !snapshot ||
    snapshot.source === 'unavailable' ||
    snapshot.headSha !== (existing.reviewedHeadSha ?? existing.reviewSnapshot?.headSha) ||
    !recoveredReviewAlreadyIngested(existing, recovered) ||
    !isDeepStrictEqual(existing.issues ?? [], recovered.issues ?? [])
  )
    return null;
  if (
    existing.reviewSnapshot &&
    (existing.reviewSnapshot.baseSha !== snapshot.baseSha ||
      existing.reviewSnapshot.diffHash !== snapshot.diffHash)
  )
    return null;
  return {
    ...existing,
    reviewSnapshot: snapshot,
    attempts: existing.attempts?.map((attempt, index, attempts) =>
      index === attempts.length - 1 ? { ...attempt, reviewSnapshot: snapshot } : attempt,
    ),
  };
}

export function recoveredReviewAlreadyIngested(
  existing: Pick<
    ReviewStatus,
    'completedAt' | 'verdict' | 'unresolvedCount' | 'feedbackSent' | 'recoveryContinuationPending'
  > &
    Partial<Pick<ReviewStatus, 'attempts'>>,
  recovered: Pick<ReviewStatus, 'completedAt'> &
    Partial<Pick<ReviewStatus, 'attempts' | 'verdict' | 'unresolvedCount'>>,
): boolean {
  // A delivery placeholder records the time the orchestration failed, which
  // can be later than the reviewer's already-written terminal signal. It is
  // not an ingested verdict and must never suppress that recovered result.
  if (isFailedReviewPlaceholder(existing)) return false;
  if (existing.verdict === 'skipped') return false;
  const existingAttempt = existing.attempts?.at(-1);
  const recoveredAttempt = recovered.attempts?.at(-1);
  if (existingAttempt?.startedAt && recoveredAttempt?.startedAt) {
    // Attempt start is the opaque generation identity. Completion clocks can
    // be inverted across the worker, node, and gateway, so they are only a
    // migration fallback when one side predates attempt-scoped artifacts.
    if (existingAttempt.startedAt !== recoveredAttempt.startedAt) return false;
    return (
      existing.verdict === recovered.verdict &&
      existing.unresolvedCount === recovered.unresolvedCount
    );
  }
  const existingAt = Date.parse(existing.completedAt ?? '');
  const recoveredAt = Date.parse(recovered.completedAt ?? '');
  return Number.isFinite(existingAt) && Number.isFinite(recoveredAt) && recoveredAt <= existingAt;
}

function applyReviewRetryCap(review: ReviewStatus, existing?: ReviewStatus): ReviewStatus {
  const attempts = review.attempts ?? existing?.attempts ?? [];
  const retryCount = Math.max(
    existing?.retryCount ?? 0,
    review.retryCount ?? 0,
    Math.max(0, attempts.length - 1),
  );
  const maxRetries = existing?.maxRetries ?? review.maxRetries;
  const exhausted = reviewFixRetriesExhausted({
    ...review,
    retryCount,
    maxRetries,
    maxRetriesExhausted: review.maxRetriesExhausted ?? existing?.maxRetriesExhausted,
    attempts,
  });
  return {
    ...review,
    retryCount,
    ...(typeof maxRetries === 'number' ? { maxRetries } : {}),
    ...(exhausted ? { maxRetriesExhausted: true, recoveryContinuationPending: false } : {}),
  };
}

export function appendRecoveredContinuationAttempt(
  existing: ReviewStatus,
  recovered: ReviewStatus,
): ReviewStatus {
  if (reviewFixRetriesExhausted(existing)) {
    return applyReviewRetryCap(existing);
  }
  if (!reviewNeedsContinuation(existing)) {
    return applyReviewRetryCap(recovered, existing);
  }
  const priorAttempts = existing.attempts ?? [];
  const recoveredAttempt = recovered.attempts?.at(-1);
  if (!recoveredAttempt) return applyReviewRetryCap(existing);
  const attempts = [
    ...priorAttempts,
    { ...recoveredAttempt, loopNumber: priorAttempts.length + 1 },
  ];
  return applyReviewRetryCap(
    {
      ...recovered,
      loopNumber: existing.loopNumber,
      attempts,
      artifactPaths: [
        ...new Set([...(existing.artifactPaths ?? []), ...(recovered.artifactPaths ?? [])]),
      ],
      timeline: attempts.flatMap((attempt) => attempt.timeline ?? []),
      startedAt: existing.startedAt ?? recovered.startedAt,
    },
    existing,
  );
}
