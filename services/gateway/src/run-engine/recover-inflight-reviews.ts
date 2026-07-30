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

import { markAgentContextStatus } from '../agents/contexts.js';
import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { EXTRA_REVIEW_SOURCE } from '../quality/review-sources.js';
import { getRun, updateRun } from '../runs/store.js';
import { readReviewFeedback } from '../self-review/feedback.js';
import type { SelfReviewResult } from '../self-review/orchestrator.js';
import { reviewerFeedbackRelPath } from '../self-review/review-agent.js';
import { signalFreshSince, terminalWorkerSignalFromRaw } from '../tasks/worker-signals.js';

import { buildPublishGateReviewStatus } from './gate-policy.js';
import { persistIndependentReviewArtifactsForRun, readPreparedPackage } from './ready-gate.js';

/**
 * A reviewer context is a recovery candidate only while it is still marked
 * in-flight. A reviewer that completed normally is flipped to `complete` by
 * `waitForReviewCompletion`; one that failed is flipped to `failed`. Only a
 * reviewer whose awaiting call was interrupted mid-flight stays `working`/
 * `launching`, so this predicate is also the dedup key — once ingested, the
 * context is marked `complete` and no longer matches.
 */
export function isRecoverableReviewerContext(ctx: Pick<AgentContext, 'role' | 'status'>): boolean {
  return ctx.role === 'self-review' && (ctx.status === 'working' || ctx.status === 'launching');
}

/**
 * Build the `IndependentReviewStatus` for a recovered reviewer, or `null` when
 * the reviewer has not actually finished (no fresh terminal signal, or feedback
 * that never parsed into a verdict). Pure so the recovery decision is unit
 * testable without slot I/O.
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
}): IndependentReviewStatus | null {
  const { run, ctx, signal, feedback, reviewSnapshot, reviewedPackage } = params;
  // Freshness anchors on the CURRENT attempt's launch time. startedAt is too
  // old for warm-reused contexts (they keep loop 1's value, so a prior loop's
  // signal looks fresh) and updatedAt is too new after a restart (startup
  // reconciliation rewrites it before this recovery runs, which would reject
  // the genuine pre-restart signal this path exists to ingest).
  const freshnessAnchor = ctx.attemptStartedAt ?? ctx.startedAt;
  if (!signal || !signalFreshSince(signal, freshnessAnchor)) return null;
  // Only a cleanly completed reviewer may stamp a verdict. A failed/blocked
  // terminal signal can coexist with parseable feedback (e.g. a PASS draft
  // written before the reviewer died) — stamping it would certify a review
  // that never finished; skipping leaves the gate to request a fresh one.
  if (signal.status !== 'complete' && signal.status !== 'done') return null;
  if (feedback.incomplete) return null;

  const priorReviews = run.engineState?.publishGate?.independentReviews ?? [];
  const reviewId = EXTRA_REVIEW_SOURCE.artifactRefs(priorReviews.length + 1).id;
  const reviewResult: SelfReviewResult = {
    verdict: feedback.verdict,
    issues: feedback.issues,
    validationDepth: feedback.validationDepth,
    runner: ctx.runner ?? undefined,
    model: ctx.model ?? undefined,
    retryCount: 0,
    reviewSnapshot,
  };
  return buildPublishGateReviewStatus({
    source: 'human-gate',
    priorReviewCount: priorReviews.length,
    reviewResult,
    requestedRunner: ctx.runner ?? null,
    workerRunner: run.metrics.runner,
    model: ctx.model ?? run.metrics.actualModel ?? run.metrics.model ?? null,
    reviewId,
    reviewedPackage: reviewedPackage ?? null,
  });
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
 * `publishGate.independentReviews`. Idempotent: it only considers reviewer
 * contexts still marked in-flight and flips each to `complete` on ingest, so a
 * later re-entry re-scans nothing. Returns the ids of the reviews it recovered.
 */
export async function recoverInflightPublicationReviews(
  runId: string,
  slotId: string,
): Promise<string[]> {
  const run = getRun(runId);
  if (!run) return [];
  const candidates = (run.agentContexts ?? []).filter(isRecoverableReviewerContext);
  if (candidates.length === 0) return [];

  const vars = await loadSlotVars(slotId);
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
  for (const ctx of candidates) {
    try {
      const recovered = await ingestRecoveredReviewer(runId, vars, ctx, stampablePackage);
      if (recovered) recoveredIds.push(recovered);
    } catch (err) {
      // One unreadable reviewer (corrupt signal/feedback file, transient slot
      // read error) must not strand the human gate or block recovery of the
      // other reviewers — mirror executePublishGateReviewPlan, which degrades a
      // failed review to a recorded outcome rather than throwing out of the gate.
      console.warn(
        `[run-engine] run ${runId.slice(0, 8)} — recovering reviewer ${ctx.id} failed, skipping: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }
  return recoveredIds;
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
): Promise<string | null> {
  const signal = await readReviewerTerminalSignal(vars, ctx);
  if (!signal || !signalFreshSince(signal, ctx.attemptStartedAt ?? ctx.startedAt)) return null; // reviewer still running
  // The reviewer's task dir is encoded in its stored task file path; feedback
  // is scoped to the reviewer's context id alongside it.
  const taskDir = ctx.taskFile ? path.posix.dirname(ctx.taskFile) : null;
  if (!taskDir) return null;
  const feedback = await readReviewFeedback(vars, taskDir, reviewerFeedbackRelPath(ctx.id));

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
  const review = buildRecoveredReview({
    run: latest,
    ctx,
    signal,
    feedback,
    reviewSnapshot,
    reviewedPackage: stampablePackage,
  });
  if (!review) return null;

  const [persisted] = await persistIndependentReviewArtifactsForRun(latest, [review]);
  updateRun(runId, {
    engineState: {
      ...latest.engineState,
      publishGate: {
        ...latest.engineState?.publishGate,
        independentReviews: [...priorReviews, persisted],
      },
    },
  });
  await markAgentContextStatus(runId, 'self-review', 'complete', {
    id: ctx.id,
    lastSignalAt: new Date().toISOString(),
  });
  console.log(
    `[run-engine] run ${runId.slice(0, 8)} — recovered in-flight publication review ${persisted.id} (verdict ${persisted.verdict}) from reviewer context ${ctx.id}`,
  );
  return persisted.id;
}
