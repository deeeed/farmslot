// recover-inflight-reviews.ts — Recover completed independent reviews whose
// result was lost to a gateway restart mid-`executeSelfReview` await.
//
// A publish-gate independent review spawns a reviewer runner and awaits its
// completion inside `executeSelfReview`. If the gateway restarts during that
// await, the reviewer keeps running on its own tmux window and writes its
// feedback + terminal signal, but the awaiting call never returns — the result
// never reaches `publishGate.independentReviews`, and because the human gate
// already cleared `pendingReviewPlan`, the review is not re-run. The gate then
// re-presents as if no review happened, discarding a completed (often ~40 min)
// review.
//
// `recoverSelfReviewFixPass` covers the mirror case for an in-flight FIX pass.
// This module covers the review pass: on human-gate re-entry, scan the run's
// persisted reviewer contexts for a completed signal + feedback and ingest the
// verdict into `independentReviews`, mirroring fix-pass recovery.

import path from 'node:path';

import type {
  AgentContext,
  IndependentReviewStatus,
  ReadyGatePrPackage,
  ReviewDiffSnapshot,
  Run,
  WorkerSignal,
} from '@farmslot/protocol';

import { upsertAgentContext } from '../agents/contexts.js';
import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { EXTRA_REVIEW_SOURCE } from '../quality/review-sources.js';
import { getRun, updateRun } from '../runs/store.js';
import { readReviewFeedback } from '../self-review/feedback.js';
import type { SelfReviewResult } from '../self-review/orchestrator.js';
import {
  resumeReviewAgentPromptDelivery,
  reviewerFeedbackRelPath,
} from '../self-review/review-agent.js';
import { getSelfReviewConfig } from '../self-review/templates.js';
import {
  isSuccessfulTerminalReviewSignal,
  isTerminalReviewArtifactError,
  TerminalReviewArtifactError,
} from '../self-review/terminal-result.js';
import { signalFreshSince, terminalWorkerSignalFromRaw } from '../tasks/worker-signals.js';

import {
  buildPublishGateReviewStatus,
  independentReviewNeedsContinuation,
  normalizeExhaustedReviewContinuation,
} from './gate-policy.js';
import { persistIndependentReviewArtifactsForRun, readPreparedPackage } from './ready-gate.js';

export { isTerminalReviewArtifactError, TerminalReviewArtifactError };

export interface PublicationReviewRecoveryResult {
  recoveredIds: string[];
  relaunchIds?: string[];
  terminalErrors: Array<{ contextId: string; message: string }>;
}

type RecoveredReviewerAction =
  | { kind: 'recovered'; id: string }
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
    'self-review',
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
    ctx.role === 'self-review' &&
    (ctx.status === 'working' ||
      ctx.status === 'launching' ||
      ctx.status === 'complete' ||
      (options.includeFailed === true && ctx.status === 'failed') ||
      (options.includeBlocked === true && ctx.status === 'blocked'))
  );
}

function isFailedReviewPlaceholder(
  review: Pick<
    IndependentReviewStatus,
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
        review.source !== 'self-review' &&
        (review.verdict === 'pass' || review.verdict === 'issues') &&
        review.unresolvedCount !== undefined,
    );
}

type RecoverableReviewRecord = Pick<IndependentReviewStatus, 'id'> &
  Partial<
    Pick<
      IndependentReviewStatus,
      | 'source'
      | 'verdict'
      | 'unresolvedCount'
      | 'feedbackSent'
      | 'recoveryContinuationPending'
      | 'issues'
    >
  >;

export function reviewerContextNeedsRecovery(
  ctx: Pick<AgentContext, 'role' | 'status' | 'artifactScope'>,
  reviews: RecoverableReviewRecord[],
  options: { includeFailed?: boolean; includeBlocked?: boolean } = {},
): boolean {
  if (!isRecoverableReviewerContext(ctx, options)) return false;
  const artifactScope = ctx.artifactScope?.trim();
  // Legacy complete contexts without a persisted scope cannot be distinguished
  // from normally ingested reviews. In-flight contexts remain recoverable via
  // the existing fallback id path.
  if (!artifactScope) return ctx.status !== 'complete';
  const recordedIndex = reviews.findIndex((review) => review.id === artifactScope);
  if (recordedIndex < 0) return ctx.status !== 'failed';
  const recorded = reviews[recordedIndex];
  if (
    ctx.status !== 'failed' &&
    recorded.source !== undefined &&
    recorded.verdict !== undefined &&
    recorded.unresolvedCount !== undefined &&
    !hasLaterSettledReview(reviews, recordedIndex) &&
    independentReviewNeedsContinuation({
      source: recorded.source,
      verdict: recorded.verdict,
      feedbackSent: recorded.feedbackSent,
      recoveryContinuationPending: recorded.recoveryContinuationPending,
      unresolvedCount: recorded.unresolvedCount,
      issues: recorded.issues,
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
  if (ctx.role !== 'self-review' || (ctx.status !== 'working' && ctx.status !== 'launching')) {
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
 * Build the `IndependentReviewStatus` for a recovered reviewer, or `null` when
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
}): IndependentReviewStatus | null {
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

  const priorReviews = run.engineState?.publishGate?.independentReviews ?? [];
  const reviewId = recoveredReviewArtifactScope(
    ctx,
    EXTRA_REVIEW_SOURCE.artifactRefs(priorReviews.length + 1).id,
  );
  const reviewResult: SelfReviewResult = {
    verdict: feedback.verdict,
    issues: feedback.issues,
    validationDepth: feedback.validationDepth,
    runner: ctx.runner ?? undefined,
    model: ctx.model ?? undefined,
    retryCount: 0,
    reviewSnapshot,
    attempts: [
      {
        loopNumber: 1,
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
      run.engineState?.publishGate?.reviewDepth?.requestedBy === 'dispatch'
        ? 'dispatch'
        : 'human-gate',
    priorReviewCount: priorReviews.length,
    reviewResult,
    requestedRunner: ctx.runner ?? null,
    workerRunner: run.metrics.runner,
    model: ctx.model ?? run.metrics.actualModel ?? run.metrics.model ?? null,
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

function isOptionalStringOrNull(value: object, key: string): boolean {
  const field = Reflect.get(value, key);
  return field === undefined || field === null || typeof field === 'string';
}

function isReviewDiffSnapshot(value: unknown): value is ReviewDiffSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const source = Reflect.get(value, 'source');
  if (
    (source !== 'local-git' && source !== 'github-pr' && source !== 'unavailable') ||
    typeof Reflect.get(value, 'capturedAt') !== 'string'
  ) {
    return false;
  }
  for (const key of ['baseRef', 'baseSha', 'headRef', 'headSha', 'diffPath', 'diffHash']) {
    if (!isOptionalStringOrNull(value, key)) return false;
  }
  for (const key of ['missingReason', 'error']) {
    const field = Reflect.get(value, key);
    if (field !== undefined && typeof field !== 'string') return false;
  }
  const diffStat = Reflect.get(value, 'diffStat');
  if (
    diffStat !== undefined &&
    (typeof diffStat !== 'object' ||
      diffStat === null ||
      !Number.isFinite(Reflect.get(diffStat, 'files')) ||
      !Number.isFinite(Reflect.get(diffStat, 'additions')) ||
      !Number.isFinite(Reflect.get(diffStat, 'deletions')))
  ) {
    return false;
  }
  const headSha = Reflect.get(value, 'headSha');
  return (
    source !== 'local-git' || (typeof headSha === 'string' && /^[0-9a-f]{7,40}$/i.test(headSha))
  );
}

function parseRecoveredReviewSnapshot(raw: string): ReviewDiffSnapshot | undefined {
  if (!raw.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isReviewDiffSnapshot(parsed) ? parsed : undefined;
  } catch (err) {
    // A malformed snapshot cannot certify a package. Keep the recovered verdict
    // unstamped so publication remains blocked and a fresh review is required.
    console.warn(
      `[run-engine] ignoring invalid recovered reviewer snapshot: ${(err as Error).message}`,
    );
    return undefined;
  }
}

async function readRecoveredReviewSnapshot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  reviewId: string,
): Promise<ReviewDiffSnapshot | undefined> {
  const scope = `${vars.remoteRepo}/${taskDir}/artifacts/${reviewId}`;
  const command = [
    `scope=${shellQuote(scope)}`,
    'latest=""',
    'for candidate in "$scope"/review-loop-*/review-diff-stat.json; do',
    '  [ -f "$candidate" ] || continue',
    '  if [ -z "$latest" ] || [ "$candidate" -nt "$latest" ]; then latest="$candidate"; fi',
    'done',
    '[ -z "$latest" ] || cat "$latest"',
  ].join('\n');
  const result = await execOnSlot(vars, command, { timeout: 10_000 });
  if (result.exitCode !== 0) {
    console.warn(
      `[run-engine] recovered-review snapshot read failed for ${reviewId}: ${(result.stderr || result.stdout || `exit ${result.exitCode}`).slice(0, 200)}`,
    );
    return undefined;
  }
  return parseRecoveredReviewSnapshot(result.stdout);
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
 * `publishGate.independentReviews`. Idempotent: complete contexts are matched to
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
  let reviews = run.engineState?.publishGate?.independentReviews ?? [];
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
    reviews = run.engineState?.publishGate?.independentReviews ?? [];
  }
  const candidates = (run.agentContexts ?? []).filter((ctx) =>
    reviewerContextNeedsRecovery(ctx, reviews, { includeFailed: true, includeBlocked: true }),
  );
  if (candidates.length === 0) return { recoveredIds: [], terminalErrors: [] };
  const vars = await loadSlotVars(slotId);

  const selfReviewConfig = await getSelfReviewConfig(run.project);
  const recoveryContinuationPending = Math.max(0, selfReviewConfig.max_retries ?? 1) > 0;
  const reviewedPackage = await readPreparedPackage(run);
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
  return { recoveredIds, relaunchIds, terminalErrors };
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
      const action = recoveredReviewerActionForPromptRecovery(promptRecovery, ctx);
      if (action) return action;
    } else if (promptRecovery === 'unsupported') {
      console.warn(
        `[run-engine] run ${runId.slice(0, 8)} — reviewer ${ctx.id} cannot resume prompt delivery; marking it failed`,
      );
      await markRecoveredReviewerContext(runId, ctx, 'failed', {});
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
    throw new TerminalReviewArtifactError(
      `Reviewer ${ctx.id} completed with an invalid result artifact: ${feedback.terminalInvalidReason}`,
    );
  }

  const latest = getRun(runId)!;
  const priorReviews = latest.engineState?.publishGate?.independentReviews ?? [];
  const reviewId = EXTRA_REVIEW_SOURCE.artifactRefs(priorReviews.length + 1).id;
  const artifactScope = recoveredReviewArtifactScope(ctx, reviewId);
  if (!ctx.artifactScope?.trim()) {
    console.warn(
      `[run-engine] recovered reviewer ${ctx.id} has no persisted artifact scope; falling back to ${artifactScope}`,
    );
  }
  const reviewSnapshot = await readRecoveredReviewSnapshot(vars, taskDir, artifactScope);
  if (options.shouldAbort?.()) return null;
  const review = buildRecoveredReview({
    run: latest,
    ctx,
    signal: freshSignal,
    feedback,
    reviewSnapshot,
    reviewedPackage: stampablePackage,
    recoveryContinuationPending,
  });
  if (!review) return null;

  const existingReview = priorReviews.find((candidate) => candidate.id === review.id);
  if (existingReview && recoveredReviewAlreadyIngested(existingReview, review)) return null;
  if (
    existingReview &&
    !isFailedReviewPlaceholder(existingReview) &&
    existingReview.verdict !== 'skipped' &&
    !independentReviewNeedsContinuation(existingReview)
  ) {
    return null;
  }
  const reviewToPersist = existingReview
    ? appendRecoveredContinuationAttempt(existingReview, review)
    : review;
  const [persisted] = await persistIndependentReviewArtifactsForRun(latest, [reviewToPersist]);
  if (options.shouldAbort?.()) return null;
  const finalRun = getRun(runId)!;
  const finalReviews = finalRun.engineState?.publishGate?.independentReviews ?? [];
  const existingIndex = finalReviews.findIndex((candidate) => candidate.id === persisted.id);
  if (
    existingIndex >= 0 &&
    recoveredReviewAlreadyIngested(finalReviews[existingIndex]!, persisted)
  ) {
    return null;
  }
  if (
    existingIndex >= 0 &&
    !isFailedReviewPlaceholder(finalReviews[existingIndex]!) &&
    finalReviews[existingIndex]!.verdict !== 'skipped' &&
    !independentReviewNeedsContinuation(finalReviews[existingIndex]!)
  ) {
    return null;
  }
  const nextReviews = [...finalReviews];
  if (existingIndex >= 0) nextReviews[existingIndex] = persisted;
  else nextReviews.push(persisted);
  if (options.shouldAbort?.()) return null;
  const contextSettled = await markRecoveredReviewerContext(runId, ctx, 'complete', {
    artifactScope,
    lastSignalAt: new Date().toISOString(),
  });
  if (!contextSettled) return null;
  updateRun(runId, {
    engineState: {
      ...finalRun.engineState,
      publishGate: {
        ...finalRun.engineState?.publishGate,
        independentReviews: nextReviews,
      },
    },
  });
  console.log(
    `[run-engine] run ${runId.slice(0, 8)} — recovered in-flight publication review ${persisted.id} (verdict ${persisted.verdict}) from reviewer context ${ctx.id}`,
  );
  return { kind: 'recovered', id: persisted.id };
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
  const priorReviews = latest.engineState?.publishGate?.independentReviews ?? [];
  const reviewId = recoveredReviewArtifactScope(
    ctx,
    EXTRA_REVIEW_SOURCE.artifactRefs(priorReviews.length + 1).id,
  );
  const existingIndex = priorReviews.findIndex((review) => review.id === reviewId);
  const existing = existingIndex >= 0 ? priorReviews[existingIndex] : undefined;
  const validationDepth = existing?.validationDepth ?? 'full-live';
  const failed = buildPublishGateReviewStatus({
    source:
      latest.engineState?.publishGate?.reviewDepth?.requestedBy === 'dispatch'
        ? 'dispatch'
        : 'human-gate',
    priorReviewCount: priorReviews.length,
    reviewResult: {
      verdict: 'blocked',
      reason: `reviewer-${signal.status}`,
      runner: ctx.runner ?? undefined,
      model: ctx.model ?? undefined,
      retryCount: 0,
      validationDepth,
      attempts: [
        {
          loopNumber: 1,
          verdict: 'failed',
          unresolvedCount: 0,
          validationDepth,
          startedAt: ctx.attemptStartedAt ?? ctx.startedAt,
          completedAt: signal.timestamp,
        },
      ],
    },
    requestedRunner: ctx.runner ?? null,
    workerRunner: latest.metrics.runner,
    model: ctx.model ?? latest.metrics.actualModel ?? latest.metrics.model ?? null,
    reviewId,
    reviewedPackage: reviewedPackage ?? null,
  });
  const reviewToPersist = {
    ...(existing ? appendRecoveredContinuationAttempt(existing, failed) : failed),
    recoveryContinuationPending: false,
  };
  const [persisted] = await persistIndependentReviewArtifactsForRun(latest, [reviewToPersist]);
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
        independentReviews: nextReviews,
      },
    },
  });
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
export function normalizeExhaustedReviewContinuationsForRun(
  runId: string,
): IndependentReviewStatus[] {
  const run = getRun(runId);
  const storedReviews = run?.engineState?.publishGate?.independentReviews ?? [];
  if (!run) return storedReviews;
  const normalized = storedReviews.map(normalizeExhaustedReviewContinuation);
  if (!normalized.some((review, index) => review !== storedReviews[index])) return storedReviews;
  updateRun(runId, {
    engineState: {
      ...run.engineState,
      publishGate: {
        ...run.engineState?.publishGate,
        independentReviews: normalized,
      },
    },
  });
  console.log(
    `[run-engine] run ${runId.slice(0, 8)} — restored pending final findings from an exhausted review loop`,
  );
  return normalized;
}

export function recoveredReviewAlreadyIngested(
  existing: Pick<
    IndependentReviewStatus,
    'completedAt' | 'verdict' | 'unresolvedCount' | 'feedbackSent' | 'recoveryContinuationPending'
  > &
    Partial<Pick<IndependentReviewStatus, 'attempts'>>,
  recovered: Pick<IndependentReviewStatus, 'completedAt'> &
    Partial<Pick<IndependentReviewStatus, 'attempts' | 'verdict' | 'unresolvedCount'>>,
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

function appendRecoveredContinuationAttempt(
  existing: IndependentReviewStatus,
  recovered: IndependentReviewStatus,
): IndependentReviewStatus {
  if (!independentReviewNeedsContinuation(existing)) return recovered;
  const priorAttempts = existing.attempts ?? [];
  const recoveredAttempt = recovered.attempts?.at(-1);
  if (!recoveredAttempt) return recovered;
  const attempts = [
    ...priorAttempts,
    { ...recoveredAttempt, loopNumber: priorAttempts.length + 1 },
  ];
  return {
    ...recovered,
    loopNumber: existing.loopNumber,
    attempts,
    artifactPaths: [
      ...new Set([...(existing.artifactPaths ?? []), ...(recovered.artifactPaths ?? [])]),
    ],
    timeline: attempts.flatMap((attempt) => attempt.timeline ?? []),
    startedAt: existing.startedAt ?? recovered.startedAt,
  };
}
