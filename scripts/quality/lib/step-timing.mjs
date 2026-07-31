// Shared step-timing instrumentation for the quality gates.
//
// The canonical gate and the per-workspace gate both run a list of labelled
// child commands. This module owns the one implementation of "run them, time
// them, print a concise ranked summary, and optionally drop a machine-readable
// artifact" so the two entrypoints stay thin and stay consistent.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Env var pointing at a directory where timing artifacts are written. */
export const TIMINGS_DIR_ENV = 'FARMSLOT_QUALITY_TIMINGS_DIR';

/** Number of entries in the ranked slowest-step summary. */
export const DEFAULT_SLOWEST_LIMIT = 5;

export function formatDuration(ms) {
  const rounded = Math.max(0, Math.round(ms));
  if (rounded < 1000) return `${rounded}ms`;
  const totalSeconds = rounded / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  let minutes = Math.floor(totalSeconds / 60);
  let seconds = Math.round(totalSeconds - minutes * 60);
  if (seconds === 60) {
    minutes += 1;
    seconds = 0;
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * Rank records slowest-first. Ties break on label so the summary is stable
 * across runs and asserted output stays deterministic.
 */
export function rankSlowest(records, limit = DEFAULT_SLOWEST_LIMIT) {
  return [...records]
    .sort((a, b) => b.ms - a.ms || a.label.localeCompare(b.label))
    .slice(0, Math.max(0, limit));
}

/**
 * Run labelled commands in order, recording elapsed wall time for each.
 * Stops at the first failing step, matching the pre-existing gate semantics.
 *
 * `spawn`, `now`, and `log` are injectable so tests can drive deterministic
 * durations and capture output without executing real commands.
 */
export function runTimedSteps(steps, options = {}) {
  const {
    prefix,
    spawn,
    now = () => performance.now(),
    log = (line) => console.log(line),
    cwd,
  } = options;
  if (typeof prefix !== 'string' || prefix === '') {
    throw new Error('runTimedSteps requires a non-empty prefix.');
  }
  if (typeof spawn !== 'function') {
    throw new Error('runTimedSteps requires a spawn function.');
  }

  const records = [];
  let failure = null;

  for (const [label, command] of steps) {
    log(`\n[${prefix}] ${label}: ${command.join(' ')}`);
    const started = now();
    const result = spawn(command[0], command.slice(1), {
      stdio: 'inherit',
      ...(cwd ? { cwd } : {}),
    });
    const ms = Math.max(0, now() - started);
    if (result.error) throw result.error;
    const status = result.status ?? 1;
    records.push({ label, command: command.join(' '), ms, status });
    log(
      `[${prefix}] done step="${label}" status=${status === 0 ? 'ok' : 'fail'} ms=${Math.round(ms)} (${formatDuration(ms)})`,
    );
    if (status !== 0) {
      failure = { label, status };
      break;
    }
  }

  return { records, failure };
}

/**
 * Concise terminal summary: one machine-parseable totals line plus the ranked
 * slowest entries. Emitted on success and on failure alike.
 */
export function renderTimingSummary(options) {
  const { prefix, records, failure = null, limit = DEFAULT_SLOWEST_LIMIT } = options;
  const totalMs = records.reduce((sum, record) => sum + record.ms, 0);
  const failed = records.filter((record) => record.status !== 0).length;
  const lines = [
    `\n[${prefix}] summary steps=${records.length} ok=${records.length - failed} failed=${failed}` +
      ` total_ms=${Math.round(totalMs)} total=${formatDuration(totalMs)}`,
  ];
  if (failure) lines.push(`[${prefix}] failed step="${failure.label}" status=${failure.status}`);
  if (records.length > 0) {
    lines.push(`[${prefix}] slowest:`);
    rankSlowest(records, limit).forEach((record, index) => {
      lines.push(
        `[${prefix}]   ${index + 1}. ${record.label} ms=${Math.round(record.ms)} (${formatDuration(record.ms)})`,
      );
    });
  }
  return lines;
}

/** Machine-readable payload for CI artifact parsing. */
export function buildTimingArtifact(options) {
  const { kind, records, failure = null, limit = DEFAULT_SLOWEST_LIMIT } = options;
  const totalMs = records.reduce((sum, record) => sum + record.ms, 0);
  return {
    kind,
    status: failure ? 'fail' : 'ok',
    failedStep: failure?.label ?? null,
    totalMs: Math.round(totalMs),
    steps: records.map((record) => ({
      label: record.label,
      command: record.command,
      ms: Math.round(record.ms),
      status: record.status === 0 ? 'ok' : 'fail',
    })),
    slowest: rankSlowest(records, limit).map((record) => ({
      label: record.label,
      ms: Math.round(record.ms),
    })),
  };
}

export function timingArtifactPath(name, env = process.env) {
  const dir = env[TIMINGS_DIR_ENV];
  if (!dir) return null;
  return path.resolve(dir, name);
}

/** Writes the artifact only when the operator/CI opted in via the env var. */
export function writeTimingArtifact(name, payload, env = process.env) {
  const target = timingArtifactPath(name, env);
  if (!target) return null;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
  return target;
}

/**
 * Set the exit status and let the event loop drain instead of calling
 * `process.exit()`.
 *
 * `process.exit()` tears the process down without flushing pending writes. When
 * stdout is a pipe — CI, `| tee`, a parent runner capturing output — that
 * truncates at the pipe buffer: a 1 MB payload arrived as 8 KB in a local probe.
 * Every quality entrypoint prints its timing summary (and, on failure, the
 * failing step) immediately before exiting, so the dropped bytes are exactly the
 * diagnostics a red build needs while the exit status still looks correct.
 */
export function finish(code) {
  process.exitCode = code;
}

/** True when `metaUrl` is the process entrypoint (so exports stay importable). */
export function isMainModule(metaUrl, argv = process.argv) {
  const entry = argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(metaUrl);
}
