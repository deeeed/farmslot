/**
 * Single, flow-agnostic builder for the consolidated gate narrative
 * ({@link GateSummary}). One entry point — `buildGateSummary` — reused by every
 * gate/retrospective surface (publication gate, retrospective, family
 * observability) so the "what happened to reach this gate" view is derived in
 * exactly one place.
 *
 * This is a PROJECTION layer. It reads already-captured state and never
 * re-derives review outcomes or re-reads artifacts:
 *   - review outcomes  ← engineState.publishGate.independentReviews
 *                         (materialized by run-completion/independent-reviews.ts)
 *   - self/extra split  ← quality/review-sources.ts (inferReviewSourceKind)
 *   - self-review skip  ← the SELF_REVIEW pipeline step's outputs.reason
 *   - worker tokens     ← run.metrics (populated at finalize)
 *   - family fix-loops  ← listRuns({ familyId })
 */

import {
  type FlowType,
  GATE_SUMMARY_KINDS,
  type GatePolicy,
  type GateSummary,
  type GateTokenSummary,
  type IndependentReviewStatus,
  PipelineSteps,
  type ReviewSummary,
  type Run,
} from '@farmslot/protocol';

import { inferReviewSourceKind } from '../quality/review-sources.js';
import { listRuns } from '../runs/store.js';

/** Family flows whose token cost rolls up into a root gate's grand total. */
const FIX_LOOP_FLOWS: ReadonlySet<FlowType> = new Set<FlowType>(['pr-complete', 'update-branch']);

function num(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** One token-bearing entry folded into the per-model rollup. */
interface TokenContribution {
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
  turns: number;
}

/**
 * Group token contributions by model into the `byModel` rollup. `input` etc. sum
 * only the entries that carried a split (reviews may report `total` alone); each
 * model's `total` always covers every contribution. Keyed by model id, null
 * preserved as its own bucket. Sorted by total descending — biggest spender first.
 */
function rollupByModel(contributions: readonly TokenContribution[]): GateTokenSummary['byModel'] {
  const byKey = new Map<string, GateTokenSummary['byModel'][number]>();
  for (const c of contributions) {
    if (c.total <= 0) continue;
    const key = c.model ?? '∅';
    const acc = byKey.get(key) ?? {
      model: c.model,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total: 0,
      turns: 0,
    };
    acc.input += c.input;
    acc.output += c.output;
    acc.cacheRead += c.cacheRead;
    acc.cacheCreation += c.cacheCreation;
    acc.total += c.total;
    acc.turns += c.turns;
    byKey.set(key, acc);
  }
  return [...byKey.values()].sort((a, b) => b.total - a.total);
}

/** Derive per-step durations from append-only checklist events (delta between consecutive marks). */
function buildChecklist(run: Run): GateSummary['checklist'] {
  const timing = run.metrics.checklistTiming;
  if (!timing?.events?.length) return undefined;
  const events = [...timing.events].sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));
  let prev: number | null = null;
  const perStepMs = events.map((e) => {
    const at = Date.parse(e.checkedAt);
    // First marked step has no prior mark to delta against — report 0 rather than guess.
    const durationMs = prev != null && Number.isFinite(at) ? Math.max(0, at - prev) : 0;
    if (Number.isFinite(at)) prev = at;
    return { stepNumber: e.stepNumber, label: e.label, durationMs };
  });
  return { events, perStepMs };
}

function isSelfReviewEntry(review: IndependentReviewStatus): boolean {
  // `source` is the explicit signal; fall back to the id-prefix registry.
  if (review.source === 'self-review') return true;
  return inferReviewSourceKind(review) === 'self-review';
}

function effectiveReviewedHead(review: IndependentReviewStatus): string | null {
  return review.reviewSnapshot?.headSha?.trim() || review.reviewedHeadSha?.trim() || null;
}

function reviewsForLatestReviewedHead(
  reviews: readonly IndependentReviewStatus[],
): IndependentReviewStatus[] {
  const latestHead = [...reviews].reverse().map(effectiveReviewedHead).find(Boolean);
  if (!latestHead) return [...reviews];
  return reviews.filter((review) => effectiveReviewedHead(review) === latestHead);
}

/**
 * A review caused re-work when it sent feedback AND something ran afterwards —
 * either a second attempt on the same review, or a later review loop.
 */
function triggeredReWork(
  review: IndependentReviewStatus,
  allReviews: readonly IndependentReviewStatus[],
): boolean {
  if (review.feedbackSent !== true) return false;
  const moreAttempts = (review.attempts?.length ?? 1) > 1;
  const laterLoop = allReviews.some((other) => other.loopNumber > review.loopNumber);
  return moreAttempts || laterLoop;
}

function selfReviewStatus(
  verdict: IndependentReviewStatus['verdict'],
): NonNullable<ReviewSummary['selfReview']>['status'] {
  switch (verdict) {
    case 'pass':
    case 'issues':
      return 'done';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return 'pending';
  }
}

function workerModel(run: Run): string | null {
  return run.metrics.actualModel ?? run.metrics.model ?? null;
}

/** Project the self-review block from review entries, falling back to the skip step. */
function buildSelfReview(
  run: Run,
  selfEntries: readonly IndependentReviewStatus[],
  allReviews: readonly IndependentReviewStatus[],
): ReviewSummary['selfReview'] {
  // The skip reason lives on the pipeline step, not the review entry — a skipped
  // self-review can be recorded as both an entry (verdict 'skipped') and a step.
  const step = run.steps.find((s) => s.name === PipelineSteps.SELF_REVIEW);
  const stepReason = typeof step?.outputs?.reason === 'string' ? step.outputs.reason : undefined;

  const latest = selfEntries.at(-1);
  if (latest) {
    const status = selfReviewStatus(latest.verdict);
    return {
      status,
      ...(status === 'skipped' && stepReason ? { reason: stepReason } : {}),
      verdict: latest.verdict,
      feedbackSent: latest.feedbackSent === true,
      unresolvedCount: latest.unresolvedCount,
      triggeredReWork: triggeredReWork(latest, allReviews),
      ...(latest.artifactPaths?.length ? { artifactPaths: latest.artifactPaths } : {}),
    };
  }
  // No self-review entry — fall back to the step alone for the skip reason.
  if (!step) return undefined;
  return {
    status: step.outputs?.skipped === true ? 'skipped' : 'pending',
    ...(stepReason ? { reason: stepReason } : {}),
    feedbackSent: false,
    unresolvedCount: 0,
    triggeredReWork: false,
  };
}

/** Build the review-outcomes section (self-review + independent reviews). */
export function buildReviewSummary(run: Run): ReviewSummary {
  const reviews = run.engineState?.publishGate?.independentReviews ?? [];
  const selfEntries = reviews.filter(isSelfReviewEntry);
  const independentEntries = reviewsForLatestReviewedHead(
    reviews.filter((r) => !isSelfReviewEntry(r)),
  );

  const selfReview = buildSelfReview(run, selfEntries, reviews);

  const independentReviews = independentEntries.map((r) => ({
    id: r.id,
    ...(r.source ? { source: r.source } : {}),
    runner: r.runner ?? null,
    model: r.model ?? null,
    crossRunner: r.crossRunner,
    loopNumber: r.loopNumber,
    verdict: r.verdict,
    unresolvedCount: r.unresolvedCount,
    feedbackSent: r.feedbackSent === true,
    triggeredReWork: triggeredReWork(r, reviews),
    attempts: r.attempts?.length ?? 1,
    ...(r.stale != null ? { stale: r.stale } : {}),
    ...(r.startedAt ? { startedAt: r.startedAt } : {}),
    ...(r.completedAt ? { completedAt: r.completedAt } : {}),
  }));

  const passingReviews = independentEntries.filter((r) => r.verdict === 'pass').length;
  const totalUnresolved =
    num(selfReview?.unresolvedCount) +
    independentEntries.reduce((sum, r) => sum + num(r.unresolvedCount), 0);
  const didAnyReviewTriggerReWork =
    selfReview?.triggeredReWork === true || independentReviews.some((r) => r.triggeredReWork);
  const requiredReviews = run.engineState?.publishGate?.reviewDepth?.minimumIndependentReviews;

  return {
    ...(selfReview ? { selfReview } : {}),
    independentReviews,
    ...(requiredReviews != null ? { requiredReviews } : {}),
    passingReviews,
    totalUnresolved,
    didAnyReviewTriggerReWork,
    summaryText: buildReviewSummaryText(selfReview, independentReviews, passingReviews),
  };
}

function buildReviewSummaryText(
  selfReview: ReviewSummary['selfReview'],
  independentReviews: ReviewSummary['independentReviews'],
  passingReviews: number,
): string {
  const parts: string[] = [];
  if (selfReview) {
    parts.push(
      selfReview.status === 'skipped'
        ? `self-review skipped (${selfReview.reason ?? 'no reason recorded'})`
        : `self-review ${selfReview.verdict ?? selfReview.status}`,
    );
  }
  if (independentReviews.length) {
    parts.push(`${passingReviews}/${independentReviews.length} independent reviews passing`);
  } else {
    parts.push('no independent reviews');
  }
  const reWork = independentReviews.filter((r) => r.triggeredReWork).length;
  parts.push(reWork ? `${reWork} triggered re-work` : 'no re-work triggered');
  return parts.join('; ');
}

/**
 * Pure roll-up of family fix-loops (pr-complete / update-branch) that ran with
 * their own worker session. Excludes the gate's own run. Returns `undefined`
 * when none qualify so the optional field stays absent. Store-free for testability.
 */
export function aggregateFamilyChainedLoops(
  run: Run,
  familyRuns: readonly Run[],
): GateTokenSummary['familyChainedLoops'] {
  const loops = familyRuns
    .filter(
      (other) =>
        other.id !== run.id &&
        FIX_LOOP_FLOWS.has(other.flowType) &&
        num(other.metrics?.sessionTotalTokens) > 0,
    )
    .map((other) => ({
      runId: other.id,
      flowType: other.flowType,
      role: 'fix-loop' as const,
      model: other.metrics.actualModel ?? other.metrics.model ?? null,
      tokens: {
        input: num(other.metrics.sessionInputTokens),
        output: num(other.metrics.sessionOutputTokens),
        total: num(other.metrics.sessionTotalTokens),
        cacheRead: num(other.metrics.sessionCacheRead),
        cacheCreation: num(other.metrics.sessionCacheCreation),
      },
      ...(other.metrics.runnerSessionPath
        ? { perTurnSessionPath: other.metrics.runnerSessionPath }
        : {}),
      createdAt: other.createdAt,
    }));
  return loops.length ? loops : undefined;
}

/** Build the token-cost section, rolling up family fix-loops. */
export function buildTokenSummary(run: Run): GateTokenSummary {
  const m = run.metrics;
  const mainWorker = {
    model: workerModel(run),
    input: num(m.sessionInputTokens),
    output: num(m.sessionOutputTokens),
    cacheRead: num(m.sessionCacheRead),
    cacheCreation: num(m.sessionCacheCreation),
    total: num(m.sessionTotalTokens),
    turns: num(m.sessionTurns),
  };

  const reviews = run.engineState?.publishGate?.independentReviews ?? [];
  const reviewTokens = reviews
    .filter((r) => r.usage && num(r.usage.totalTokens) > 0)
    .map((r) => ({
      id: r.id,
      model: r.usage?.actualModel ?? r.model ?? null,
      input: num(r.usage?.inputTokens),
      output: num(r.usage?.outputTokens),
      cacheRead: num(r.usage?.cacheRead),
      cacheCreation: num(r.usage?.cacheCreation),
      total: num(r.usage?.totalTokens),
    }));

  const family = run.familyId ? listRuns({ familyId: run.familyId }).runs : [];
  const familyChainedLoops = aggregateFamilyChainedLoops(run, family) ?? [];

  const familyTotalTokens =
    mainWorker.total +
    reviewTokens.reduce((sum, r) => sum + r.total, 0) +
    familyChainedLoops.reduce((sum, c) => sum + c.tokens.total, 0);

  const runnerSessionPaths = [
    m.runnerSessionPath,
    ...reviews.map((r) => r.usage?.runnerSessionPath),
    ...familyChainedLoops.map((c) => c.perTurnSessionPath),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  const byModel = rollupByModel([
    { ...mainWorker },
    ...reviewTokens.map((r) => ({
      model: r.model,
      input: r.input,
      output: r.output,
      cacheRead: r.cacheRead,
      cacheCreation: r.cacheCreation,
      total: r.total,
      turns: 0,
    })),
    ...familyChainedLoops.map((c) => ({ model: c.model, ...c.tokens, turns: 0 })),
  ]);

  // Re-work = the post-gate family fix-loops plus human nudges on the main run.
  const reWorkTokens = familyChainedLoops.reduce((sum, c) => sum + c.tokens.total, 0);
  const nudgeCount = num(m.nudgeCount);
  const reWork =
    familyChainedLoops.length > 0 || nudgeCount > 0
      ? {
          tokens: reWorkTokens,
          loops: familyChainedLoops.length,
          ...(nudgeCount > 0 ? { nudgeCount } : {}),
        }
      : undefined;

  return {
    mainWorker,
    reviews: reviewTokens,
    byModel,
    ...(reWork ? { reWork } : {}),
    ...(familyChainedLoops.length ? { familyChainedLoops } : {}),
    familyTotalTokens,
    perTurnDetailsAvailable: runnerSessionPaths.length > 0,
    ...(runnerSessionPaths.length ? { runnerSessionPaths } : {}),
  };
}

/**
 * Single entry point. `gatePolicy` is passed in by callers that already compute
 * it (the publication gate) rather than re-derived here.
 */
export function buildGateSummary(
  run: Run,
  kind: GateSummary['kind'],
  opts?: { gatePolicy?: GatePolicy },
): GateSummary {
  const review = buildReviewSummary(run);
  const tokens = buildTokenSummary(run);
  const checklist = buildChecklist(run);
  const worker = {
    model: workerModel(run),
    turns: num(run.metrics.sessionTurns),
    ...(run.metrics.outcome ? { outcome: run.metrics.outcome } : {}),
  };

  return {
    kind,
    flowType: run.flowType,
    ...(opts?.gatePolicy ? { gatePolicy: opts.gatePolicy } : {}),
    headline: buildHeadline(worker, review),
    worker,
    review,
    tokens,
    ...(checklist ? { checklist } : {}),
    capturedAt: new Date().toISOString(),
  };
}

function buildHeadline(worker: GateSummary['worker'], review: ReviewSummary): string {
  return `Worker ${worker.outcome ?? 'done'} in ${worker.turns} turns; ${review.summaryText ?? 'no review data'}`;
}

/**
 * Lazy back-compat: attach `gateSummary` on-read to gate/retrospective decision
 * payloads created before the field existed. Returns a shallow copy with the
 * enriched decisions when anything changed, otherwise the run unchanged. Gate
 * surfaces (runGet, runForSlot, decisionList) call this so historical runs show
 * the panel without a migration or backfill job.
 *
 * Deliberate tradeoff — this rebuilds the summary on every read for a run that
 * lacks one, rather than persisting it back to the store. The cost is bounded:
 * `buildGateSummary` is a pure in-memory projection (the only fan-out is
 * `listRuns({ familyId })`, an in-memory filter), and only PRE-feature runs ever
 * hit this path — every run created after this ships persists `gateSummary` at
 * gate time, so the rebuild set shrinks to a fixed, rarely-viewed tail. We avoid
 * persist-on-read on purpose: writing from a read path (especially the
 * multi-run `decisionList`) adds I/O and races for no correctness benefit.
 */
export function enrichDecisionsWithGateSummary(run: Run): Run {
  if (!run.decisions?.length) return run;
  let mutated = false;
  // Narrow on the payload `kind` tag (the canonical RunDecisionPayload
  // discriminant) — not decision.type, which is the engine-prefixed
  // `engine_human_gate`. Narrowing first lets every field access stay
  // type-safe with no casts; both branches' payloads already declare `gateSummary`.
  const decisions = run.decisions.map((decision) => {
    const payload = decision.payload;
    if (payload?.kind === 'ready' && !payload.gateSummary) {
      mutated = true;
      const gateSummary = buildGateSummary(run, GATE_SUMMARY_KINDS.publication, {
        gatePolicy: payload.prPackage?.gatePolicy ?? payload.gatePolicy,
      });
      return { ...decision, payload: { ...payload, gateSummary } };
    }
    if (payload?.kind === 'retrospective' && !payload.gateSummary) {
      mutated = true;
      const gateSummary = buildGateSummary(run, GATE_SUMMARY_KINDS.review);
      return { ...decision, payload: { ...payload, gateSummary } };
    }
    return decision;
  });
  return mutated ? { ...run, decisions } : run;
}
