import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ANALYTICS_RECORD_SCHEMA_VERSION,
  type AnalyticsQueryParams,
  type AnalyticsQueryResult,
  type DurationStats,
  FAILURE_REASONS,
  type FailureReason,
  type HostLoadSnapshot,
  isTerminalRunStatus,
  type LoopStats,
  PipelineSteps,
  type Run,
  type RunAnalyticsRecord,
  type RunStep,
} from '@farmslot/protocol';

import { farmslotRoot } from '../fleet/state.js';

import { getAllRuns, shouldUseIsolatedRunsDir } from './store.js';

// Append-only analytics sink, decoupled from the prunable run-history store.
// One record per terminal run, written before the run JSON can be deleted/archived.
// See docs/plans/pipeline-ops-analytics-goal.md.

let _analyticsDir: string | null = null;
const analyticsAppendTails = new Map<string, Promise<void>>();

// Lazy so the store↔analytics import cycle (store emits, we read its test predicate)
// resolves at runtime rather than module-init time.
function analyticsDir(): string {
  if (_analyticsDir) return _analyticsDir;
  if (process.env.FARMSLOT_ANALYTICS_DIR) {
    _analyticsDir = process.env.FARMSLOT_ANALYTICS_DIR;
  } else if (shouldUseIsolatedRunsDir(process.env, process.argv)) {
    _analyticsDir = path.join(os.tmpdir(), `farmslot-test-analytics-${process.pid}`);
  } else {
    _analyticsDir = path.join(farmslotRoot, '.runs', 'analytics');
  }
  return _analyticsDir;
}

function monthFile(ts: string): string {
  // events-YYYY-MM.ndjson — month rotation keeps individual files small without a DB.
  const ym = ts.slice(0, 7); // ISO "2026-06-22T..." → "2026-06"
  return path.join(analyticsDir(), `events-${ym}.ndjson`);
}

// ─── Derivation helpers (pure) ───

function stepDurationMs(step: RunStep): number | undefined {
  if (typeof step.durationMs === 'number') return step.durationMs;
  if (step.startedAt && step.completedAt) {
    const d = Date.parse(step.completedAt) - Date.parse(step.startedAt);
    return Number.isFinite(d) && d >= 0 ? d : undefined;
  }
  return undefined;
}

function hostFromSlotId(slotId: string | null): string {
  if (!slotId) return 'unknown';
  const machine = slotId.split('-')[0];
  return machine || 'unknown';
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Snapshot machine pressure at prepare start. `load1`/`freeMemPct` reflect the ORCHESTRATOR
 * (gateway) host — accurate for local slots; for remote slots this is the orchestrator's load,
 * not the remote node's (reading remote loadavg over ssh is deferred). `activeRunsOnHost` is
 * exact per slot-host, computed from the live run store.
 */
export function captureHostLoadSnapshot(slotId: string | null): HostLoadSnapshot {
  const host = hostFromSlotId(slotId);
  const total = os.totalmem();
  let activeRunsOnHost = 0;
  for (const r of getAllRuns()) {
    if (r.slotId && hostFromSlotId(r.slotId) === host && !isTerminalRunStatus(r.status)) {
      activeRunsOnHost++;
    }
  }
  return {
    load1: round2(os.loadavg()[0]),
    freeMemPct: total > 0 ? round2((os.freemem() / total) * 100) : 0,
    activeRunsOnHost,
  };
}

/** The step a non-done run was sitting on: an explicitly failed step, else the last running one. */
function failingStep(run: Run): string | null {
  const steps = run.steps ?? [];
  const failed = steps.find((s) => s.status === 'failed');
  if (failed) return failed.name;
  const running = [...steps].reverse().find((s) => s.status === 'running');
  return running ? running.name : null;
}

const REASON_PATTERNS: ReadonlyArray<[RegExp, FailureReason]> = [
  [/merge|conflict/i, 'merge-conflict'],
  [/metro/i, 'metro-timeout'],
  [/cdp|chrome|devtools/i, 'cdp-timeout'],
  [/yarn|npm|install|lockfile|dependenc/i, 'dep-install'],
  [/auth|login|keychain|credential/i, 'auth'],
  [/typecheck|tsc|type error|type-check/i, 'type'],
  [/lint/i, 'lint'],
  [/\btest\b|jest|vitest|spec/i, 'test'],
  [/\bci\b|workflow|check failed/i, 'ci-flake'],
  [/timeout|timed out|deadline/i, 'timeout'],
];

/**
 * Best-effort failure cause for a non-`done` terminal run. Phase 2 sets an explicit
 * `failureReason` on the failing step's outputs; this keyword classifier is the fallback
 * for runs where no explicit reason was recorded (including all backfilled history).
 */
function classifyFailureReason(run: Run, failedStep: string | null): FailureReason {
  if (run.status === 'cancelled') return 'operator-cancelled';
  // Explicit reason recorded on the failing step wins over heuristics — but only if it's a known
  // code, so a stray string in step outputs can't escape the normalized enum.
  const explicit = (run.steps ?? []).find((s) => s.name === failedStep)?.outputs?.failureReason;
  if (typeof explicit === 'string' && (FAILURE_REASONS as readonly string[]).includes(explicit)) {
    return explicit as FailureReason;
  }
  const haystack = `${run.error ?? ''} ${failedStep ?? ''}`;
  for (const [pattern, reason] of REASON_PATTERNS) {
    if (pattern.test(haystack)) return reason;
  }
  return 'unknown';
}

function selfReviewLoopCount(run: Run): number | null {
  const attempts = (run.steps ?? []).find((s) => s.name === 'self-review')?.outputs?.attempts;
  return Array.isArray(attempts) ? attempts.length : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function ciOutputs(run: Run): {
  result: string | null;
  pollCount: number | null;
  inlineFix: number | null;
} {
  const o = (run.steps ?? []).find((s) => s.name === 'ci-watch')?.outputs;
  if (!o) return { result: null, pollCount: null, inlineFix: null };
  return {
    result: typeof o.result === 'string' ? o.result : null,
    pollCount: numberOrNull(o.pollCount),
    inlineFix: numberOrNull(o.inlineFixAttempts),
  };
}

function hostLoadFromRun(run: Run): HostLoadSnapshot | null {
  const raw = (run.steps ?? []).find((s) => s.name === 'prepare')?.outputs?.hostLoad;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (numberOrNull(r.load1) == null) return null;
  return {
    load1: r.load1 as number,
    freeMemPct: typeof r.freeMemPct === 'number' ? r.freeMemPct : 0,
    activeRunsOnHost: typeof r.activeRunsOnHost === 'number' ? r.activeRunsOnHost : 0,
  };
}

function humanReviewersRequestingChanges(run: Run): number | null {
  const retro = (run.decisions ?? []).find((d) => d.payload?.kind === 'retrospective')?.payload;
  if (retro && retro.kind === 'retrospective') {
    return numberOrNull(retro.commentsTriageSummary?.humanReviewersRequestingChanges);
  }
  return null;
}

function templateKey(run: Run): string | null {
  const p = run.templateProvenance;
  if (!p) return null;
  return `${p.templateName}@${p.templateVariant ?? 'default'}`;
}

/**
 * Worker session tokens for this run, attributed to the model that actually ran
 * (`actualModel` over the dispatched `model` — fast-mode can swap them). `total`
 * is null when the runner reported no usage; `byModel` is empty in that case.
 */
function workerTokens(run: Run): { total: number | null; byModel: Record<string, number> } {
  const total = numberOrNull(run.metrics?.sessionTotalTokens);
  if (total == null || total <= 0) return { total, byModel: {} };
  const model = run.metrics?.actualModel ?? run.metrics?.model ?? 'unknown';
  return { total, byModel: { [model]: total } };
}

/** Flatten a terminal Run into a compact analytics record. Pure — no I/O. */
export function buildAnalyticsRecord(
  run: Run,
  opts?: { backfilled?: boolean },
): RunAnalyticsRecord {
  const steps = (run.steps ?? []).map((s) => ({
    name: s.name,
    status: s.status,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    durationMs: stepDurationMs(s),
  }));

  const wallMs =
    run.completedAt && run.createdAt
      ? Math.max(0, Date.parse(run.completedAt) - Date.parse(run.createdAt))
      : null;
  const stepSum = steps.reduce(
    (acc, s) => acc + (s.durationMs && s.durationMs > 0 ? s.durationMs : 0),
    0,
  );
  const idleMs = wallMs != null ? Math.max(0, wallMs - stepSum) : null;

  const failedStep = run.status === 'done' ? null : failingStep(run);
  const failureReason = run.status === 'done' ? null : classifyFailureReason(run, failedStep);
  const ci = ciOutputs(run);
  const tokens = workerTokens(run);

  return {
    schemaVersion: ANALYTICS_RECORD_SCHEMA_VERSION,
    // Deterministic fallback chain (no new Date() — keeps this builder pure). updatedAt is
    // always set on a real Run, so this never produces an empty ts in practice.
    ts: run.completedAt ?? run.updatedAt ?? run.createdAt,
    runId: run.id,
    familyId: run.familyId,
    project: run.project,
    host: hostFromSlotId(run.slotId),
    slotId: run.slotId,
    flowType: run.flowType,
    lane: run.lane,
    variant: run.variant ?? null,
    runner: run.metrics?.runner ?? null,
    model: run.metrics?.model ?? null,
    status: run.status,
    outcome: run.metrics?.outcome ?? null,
    failedStep,
    failureReason,
    steps,
    wallMs,
    idleMs,
    nudgeCount: run.metrics?.nudgeCount ?? 0,
    selfReviewLoops: selfReviewLoopCount(run),
    ciResult: ci.result,
    ciPollCount: ci.pollCount,
    ciInlineFixAttempts: ci.inlineFix,
    humanReviewersRequestingChanges: humanReviewersRequestingChanges(run),
    hostLoad: hostLoadFromRun(run),
    totalTokens: tokens.total,
    tokensByModel: tokens.byModel,
    templateKey: templateKey(run),
    ...(opts?.backfilled ? { backfilled: true } : {}),
  };
}

// ─── Sink I/O ───

export async function appendAnalyticsRecord(record: RunAnalyticsRecord): Promise<void> {
  await mkdir(analyticsDir(), { recursive: true });
  await appendFile(monthFile(record.ts), `${JSON.stringify(record)}\n`, 'utf-8');
}

export interface AnalyticsReadResult {
  records: RunAnalyticsRecord[];
  parseFailures: number;
}

/** Read every events-*.ndjson record. Tolerates malformed lines (counted, not thrown). */
export async function readAllAnalyticsRecords(): Promise<AnalyticsReadResult> {
  let files: string[];
  try {
    files = await readdir(analyticsDir());
  } catch (err) {
    // A missing dir means the sink hasn't been created yet (no terminal runs emitted) — an
    // empty corpus is a valid state. Only ENOENT is swallowed; any other failure (permissions,
    // I/O) must surface rather than masquerade as "no analytics".
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], parseFailures: 0 };
    throw err;
  }
  const records: RunAnalyticsRecord[] = [];
  let parseFailures = 0;
  for (const file of files.filter((f) => f.startsWith('events-') && f.endsWith('.ndjson')).sort()) {
    const content = await readFile(path.join(analyticsDir(), file), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: RunAnalyticsRecord;
      try {
        record = JSON.parse(trimmed) as RunAnalyticsRecord;
      } catch {
        // A single corrupt line (partial append, manual edit) must not blind the whole
        // corpus. Count it so the query surface can report degraded coverage.
        parseFailures++;
        continue;
      }
      // Forward-compat: skip records written by a newer schema than this build understands,
      // rather than mis-reading a changed shape. Safe while only version 1 exists.
      if (
        typeof record.schemaVersion === 'number' &&
        record.schemaVersion > ANALYTICS_RECORD_SCHEMA_VERSION
      ) {
        continue;
      }
      records.push(record);
    }
  }
  return { records, parseFailures };
}

// ─── Aggregation (pure) ───

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  // Standard nearest-rank: ceil(p/100 * n) as a 1-based rank, clamped to [1, n].
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

function durationStats(values: number[]): DurationStats {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

function loopStats(values: number[]): LoopStats {
  const distribution: Record<string, number> = {};
  for (const v of values) distribution[v] = (distribution[v] ?? 0) + 1;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    distribution,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

function matchesFilter(r: RunAnalyticsRecord, p: AnalyticsQueryParams): boolean {
  if (p.project && r.project !== p.project) return false;
  if (p.host && r.host !== p.host) return false;
  if (p.flowType && r.flowType !== p.flowType) return false;
  if (p.runner && r.runner !== p.runner) return false;
  if (p.model && r.model !== p.model) return false;
  if (p.lane && r.lane !== p.lane) return false;
  if (p.since && r.ts < p.since) return false;
  if (p.until && r.ts >= p.until) return false;
  return true;
}

const STEP_ORDER: string[] = Object.values(PipelineSteps);

/** Aggregate a full record set into the dashboard query result. Pure — no I/O. */
export function aggregateAnalytics(
  all: RunAnalyticsRecord[],
  params: AnalyticsQueryParams,
  generatedAt: string,
  parseFailures = 0,
): AnalyticsQueryResult {
  // Dedup by runId, keeping the last record seen (files read oldest→newest, append order within
  // a file is chronological → last wins). Guards against a rare crash-window double-emit and
  // makes a replayed run (terminal more than once) count exactly once.
  const latestByRun = new Map<string, RunAnalyticsRecord>();
  for (const r of all) latestByRun.set(r.runId, r);
  const records = [...latestByRun.values()];
  const matched = records.filter((r) => matchesFilter(r, params));

  const byStatus: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  const byRunner: Record<string, number> = {};
  const byTemplate: Record<string, number> = {};
  const failureByStep: Record<string, number> = {};
  const failureByReason: Record<string, number> = {};
  const ciResultBreakdown: Record<string, number> = {};
  const stepDurations = new Map<string, number[]>();
  const wallValues: number[] = [];
  const idleValues: number[] = [];
  const selfReviewValues: number[] = [];
  const pollValues: number[] = [];
  const inlineFixValues: number[] = [];
  const nudgeByModel = new Map<string, { sum: number; n: number }>();
  const tokenValues: number[] = [];
  const tokensByModelAgg: Record<string, number> = {};
  let nudgeSum = 0;
  let zeroNudge = 0;

  for (const r of matched) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const model = r.model ?? 'unknown';
    byModel[model] = (byModel[model] ?? 0) + 1;
    const runner = r.runner ?? 'unknown';
    byRunner[runner] = (byRunner[runner] ?? 0) + 1;
    const template = r.templateKey ?? 'none';
    byTemplate[template] = (byTemplate[template] ?? 0) + 1;
    if (r.failedStep) failureByStep[r.failedStep] = (failureByStep[r.failedStep] ?? 0) + 1;
    if (r.failureReason)
      failureByReason[r.failureReason] = (failureByReason[r.failureReason] ?? 0) + 1;
    for (const s of r.steps) {
      if (typeof s.durationMs === 'number' && s.durationMs > 0) {
        const arr = stepDurations.get(s.name) ?? [];
        arr.push(s.durationMs);
        stepDurations.set(s.name, arr);
      }
    }
    if (r.wallMs != null) wallValues.push(r.wallMs);
    if (r.idleMs != null) idleValues.push(r.idleMs);
    if (r.selfReviewLoops != null) selfReviewValues.push(r.selfReviewLoops);
    if (r.ciResult) ciResultBreakdown[r.ciResult] = (ciResultBreakdown[r.ciResult] ?? 0) + 1;
    if (r.ciPollCount != null) pollValues.push(r.ciPollCount);
    if (r.ciInlineFixAttempts != null) inlineFixValues.push(r.ciInlineFixAttempts);
    if (r.totalTokens != null) tokenValues.push(r.totalTokens);
    for (const [m, t] of Object.entries(r.tokensByModel ?? {})) {
      tokensByModelAgg[m] = (tokensByModelAgg[m] ?? 0) + t;
    }
    nudgeSum += r.nudgeCount;
    if (r.nudgeCount === 0) zeroNudge++;
    const m = nudgeByModel.get(r.model ?? 'unknown') ?? { sum: 0, n: 0 };
    m.sum += r.nudgeCount;
    m.n += 1;
    nudgeByModel.set(r.model ?? 'unknown', m);
  }

  const bottleneck = [...stepDurations.entries()]
    .map(([step, values]) => ({ step, stats: durationStats(values) }))
    .sort((a, b) => {
      const ia = STEP_ORDER.indexOf(a.step);
      const ib = STEP_ORDER.indexOf(b.step);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

  const nudgesByModel: Record<string, number> = {};
  for (const [model, { sum, n }] of nudgeByModel) {
    nudgesByModel[model] = n ? round2(sum / n) : 0;
  }

  // Dimensions reflect the full scanned corpus so UI filter dropdowns offer every value.
  const distinct = (pick: (r: RunAnalyticsRecord) => string | null) =>
    [...new Set(records.map(pick).filter((v): v is string => !!v))].sort();

  return {
    generatedAt,
    matchedRuns: matched.length,
    scannedRuns: records.length,
    parseFailures,
    byStatus,
    byModel,
    tokensByModel: tokensByModelAgg,
    tokens: durationStats(tokenValues),
    byRunner,
    byTemplate,
    bottleneck,
    wall: durationStats(wallValues),
    idle: durationStats(idleValues),
    failureByStep,
    failureByReason,
    selfReviewLoops: loopStats(selfReviewValues),
    ci: {
      resultBreakdown: ciResultBreakdown,
      pollCount: durationStats(pollValues),
      inlineFixAttempts: durationStats(inlineFixValues),
    },
    nudges: {
      avg: matched.length ? round2(nudgeSum / matched.length) : 0,
      zeroRate: matched.length ? round2(zeroNudge / matched.length) : 0,
      byModel: nudgesByModel,
    },
    dimensions: {
      projects: distinct((r) => r.project),
      hosts: distinct((r) => r.host),
      flowTypes: distinct((r) => r.flowType),
      runners: distinct((r) => r.runner),
      models: distinct((r) => r.model),
    },
  };
}

/**
 * Emit the analytics record for a run that has just reached a terminal state. Returns the append
 * promise (which rejects on a sink-write failure), or null when nothing was emitted (non-terminal,
 * already emitted, or a build failure).
 *
 * `run.analyticsEmittedAt` is set only after the append durably succeeds, so it means "written",
 * not "attempted". Callers choose how to treat the promise: updateRun fires-and-forgets (a dropped
 * append leaves the run un-flagged and recoverable via backfill); archiveRun/deleteRun await it and
 * skip eviction on rejection so a run is never pruned before its record lands. A second emit within
 * the append window can write a duplicate line — harmless, since the query layer dedups by runId.
 */
export function emitAnalyticsForTerminalRun(
  run: Run,
  opts?: { backfilled?: boolean },
): Promise<void> | null {
  if (!isTerminalRunStatus(run.status)) return null;
  if (run.analyticsEmittedAt) return null;
  let record: RunAnalyticsRecord;
  try {
    // buildAnalyticsRecord runs synchronously — keep it inside the try so a malformed run can't
    // throw out of updateRun/archiveRun/deleteRun. A build failure leaves the run un-emitted
    // (flag unset) and recoverable via analyticsBackfill.
    record = buildAnalyticsRecord(run, opts);
  } catch (err) {
    console.warn(
      `[analytics] failed to build record for run ${run.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  // Snapshot the record at call time, then append behind any in-flight write for
  // this run. Concurrent appendFile calls are unordered; last-record-wins query
  // would otherwise keep a stale failure row after a force-complete override.
  const emittedAt = run.completedAt ?? run.updatedAt ?? run.createdAt;
  const previous = analyticsAppendTails.get(run.id) ?? Promise.resolve();
  // Store and return the same tail. A separate `finally` promise would reject
  // unobserved and could terminate the gateway; the map would also retain it
  // because cleanup compared against `next` instead of that wrapper.
  const tail = previous
    .catch(() => undefined)
    .then(() =>
      appendAnalyticsRecord(record).then(() => {
        run.analyticsEmittedAt = emittedAt;
      }),
    )
    .finally(() => {
      if (analyticsAppendTails.get(run.id) === tail) analyticsAppendTails.delete(run.id);
    });
  analyticsAppendTails.set(run.id, tail);
  return tail;
}
