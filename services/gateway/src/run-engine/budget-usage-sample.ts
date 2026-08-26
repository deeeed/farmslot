// budget-usage-sample.ts — Gateway wrapper around shared session-usage sampling
// for the soft turn/token budget guard.
//
// Local + remote: bounded incremental complete-line sampling (shared advance
// helper). Remote reads only new bytes from the durable offset via a short
// Python seek/read on the slot (no full-transcript reparse on each poll).

import { open, stat } from 'node:fs/promises';

import {
  advanceIncrementalFromBytes,
  bufferHasNoRecordBoundary,
  emptyIncrementalSessionUsageState,
  INCREMENTAL_SESSION_USAGE_MAX_BYTES_PER_SAMPLE,
  INCREMENTAL_SESSION_USAGE_MAX_OVERSIZED_BYTES,
  type IncrementalSessionUsageState,
  pinnedIncrementalSessionUsageState,
  sampleSessionUsageIncremental,
} from '@farmslot/slot-config';

import type { SlotVars } from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { getRunnerSessionUsageProvider } from '../runners/registry.js';
import type { RunnerSessionUsageProvider } from '../runners/session-usage-provider.js';

/** Durable monitor sample state (also persisted on Run.monitorState). */
export type BudgetUsageSampleState = IncrementalSessionUsageState;

export type BudgetUsageSampleResult = {
  turns: number | null;
  totalTokens: number | null;
  availability: 'available' | 'unavailable' | 'cached';
  unavailableReason?: string;
  /** True when accounting integrity/capability is unavailable and the guard must warn. */
  enforcementFailure?: boolean;
  /**
   * True when the runner has no session-usage provider at all (cursor, grok, …).
   * A missing capability is an operator-facing gap, not worker misbehavior, so the
   * guard records it without instructing the worker to stop expanding scope.
   */
  unsupportedRunner?: boolean;
  nextState: BudgetUsageSampleState;
};

export function emptyBudgetUsageSampleState(): BudgetUsageSampleState {
  return emptyIncrementalSessionUsageState();
}

/**
 * Build an unavailable result that always carries `prior` forward.
 *
 * Sampling state is durable: it holds the transcript path and the byte offset counting
 * started from. A branch that returns fresh state instead nulls the path and rewinds the
 * offset to zero, and continuity detection needs a non-null prior path to fail closed —
 * so the next healthy poll silently re-reads the transcript from the beginning and
 * charges a retained parent's whole history to this run. Every unavailable path goes
 * through here so that cannot be reintroduced one branch at a time.
 */
function unavailable(
  prior: BudgetUsageSampleState,
  unavailableReason: string,
  overrides: Omit<Partial<BudgetUsageSampleState>, 'path'> = {},
  flags: { enforcementFailure?: boolean; unsupportedRunner?: boolean } = {},
): BudgetUsageSampleResult {
  // `path` is deliberately not settable here. Stamping a new transcript onto state that
  // counts a different one leaves the new path beside the old offset and reference, and
  // continuity then looks intact — so the next readable poll samples mid-file against
  // the wrong session instead of failing closed.
  return {
    turns: null,
    totalTokens: null,
    availability: 'unavailable',
    unavailableReason,
    // Integrity loss is permanent for the run. A transient branch reporting no
    // enforcement failure over a state that already lost integrity would let the guard
    // treat accounting as merely unavailable and quietly resume retrying.
    enforcementFailure: prior.integrityFailureReason !== undefined,
    ...flags,
    nextState: {
      ...prior,
      ...overrides,
      unavailableReason,
      sampledAt: new Date().toISOString(),
    },
  };
}

/**
 * Tail read for a warm baseline: enough to find the last record boundary, and for a
 * runner that restates session totals, the last reading. Widened once to the sampler's
 * oversized-record allowance before failing closed, because a single large tool record
 * after the last reading would otherwise push it out of the window and cost a healthy
 * retained session.
 */
const BASELINE_TAIL_SCAN_BYTES = INCREMENTAL_SESSION_USAGE_MAX_BYTES_PER_SAMPLE;
const BASELINE_TAIL_SCAN_WIDENED_BYTES = INCREMENTAL_SESSION_USAGE_MAX_OVERSIZED_BYTES;

async function remoteFileStat(
  vars: SlotVars,
  filePath: string,
): Promise<{ size: number; mtimeMs: number } | null> {
  const result = await execOnSlot(
    vars,
    `stat -f '%z %m' ${shellQuote(filePath)} 2>/dev/null || stat -c '%s %Y' ${shellQuote(filePath)} 2>/dev/null`,
  );
  if (result.exitCode !== 0) return null;
  const parts = result.stdout.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const size = Number(parts[0]);
  const mtimeSec = Number(parts[1]);
  if (!Number.isFinite(size) || !Number.isFinite(mtimeSec)) return null;
  return { size, mtimeMs: mtimeSec * 1000 };
}

/**
 * Read up to maxBytes from offset on a remote path (binary-safe base64).
 * Uses a short Python seek/read so we never re-parse the whole transcript.
 */
async function remoteReadBytes(
  vars: SlotVars,
  filePath: string,
  offset: number,
  maxBytes: number,
): Promise<Buffer | null> {
  const py = [
    'import base64,sys',
    `p=${JSON.stringify(filePath)}`,
    `o=${Math.max(0, Math.floor(offset))}`,
    `n=${Math.max(0, Math.floor(maxBytes))}`,
    'f=open(p,"rb")',
    'f.seek(o)',
    'b=f.read(n)',
    'f.close()',
    'sys.stdout.write(base64.b64encode(b).decode("ascii"))',
  ].join(';');
  const result = await execOnSlot(vars, `python3 -c ${shellQuote(py)} 2>/dev/null`);
  if (result.exitCode !== 0) return null;
  const b64 = result.stdout.trim();
  if (!b64) return Buffer.alloc(0);
  try {
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
}

/**
 * Replay a transcript tail purely to recover the reference reading in force at its end.
 *
 * Counters accumulated here are partial sums over an arbitrary window and are discarded;
 * only `lastCumulative` is meaningful. Returns null when the tail is corrupt in a way
 * that matters to the caller.
 */
function replayTailReference(
  tail: Buffer,
  lastNewline: number,
  tailStart: number,
  provider: RunnerSessionUsageProvider,
): BudgetUsageSampleState | null {
  let replay = pinnedIncrementalSessionUsageState();
  let scanned = 0;
  for (const line of tail
    .subarray(0, lastNewline + 1)
    .toString('utf8')
    .split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    scanned += 1;
    try {
      replay = provider.applyRecord(replay, JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // When the window opens mid-transcript its first line is a record fragment, so it
      // is expected to be unparseable. A full-transcript window has no such excuse.
      if (tailStart > 0 && scanned === 1) continue;
      // Past that, corruption matters only to a runner whose reference this replay is
      // recovering: continuing would keep an older reading and charge the child the gap.
      // For every other runner the pin needs nothing but the byte offset, and failing
      // here would tear down a healthy warm handoff over one bad line.
      if (!provider.restatesSessionTotals) continue;
      return null;
    }
  }
  return replay;
}

/**
 * Pin budget accounting at the end of a retained transcript.
 *
 * A warm handoff inherits the parent's transcript, so the child must be charged only
 * for what it appends. That is entirely a matter of where counting starts: providers
 * report increments (codex converts its session totals in `foldCodexSessionTotals`),
 * so counters started at this offset measure exactly the work after it.
 *
 * The pin lands on the last record boundary, never raw EOF — a byte offset inside a
 * half-written record makes the next sample parse the record's suffix and fail
 * accounting closed as malformed JSONL for the rest of the run.
 *
 * Returns null when the transcript cannot be read or has no record boundary within the
 * scan window; callers fail the warm baseline closed rather than start a run with
 * unenforceable accounting.
 */
export async function captureBudgetUsageBaselinePin(params: {
  vars: SlotVars;
  runner?: string | null;
  runnerSessionPath: string;
}): Promise<BudgetUsageSampleState | null> {
  const { vars, runner, runnerSessionPath } = params;
  const provider = getRunnerSessionUsageProvider(runner);
  if (!provider) return null;

  let size: number;
  let mtimeMs: number;
  let readTail: (offset: number, length: number) => Promise<Buffer | null>;
  if (isLocal(vars.host, vars.machine)) {
    const st = await stat(runnerSessionPath);
    // Directory transcripts are not incrementally sampled, so there is no offset to pin.
    if (st.isDirectory()) return null;
    size = st.size;
    mtimeMs = st.mtimeMs;
    readTail = async (offset, length) => {
      const buf = Buffer.alloc(length);
      const fh = await open(runnerSessionPath, 'r');
      try {
        await fh.read(buf, 0, length, offset);
      } finally {
        await fh.close();
      }
      return buf;
    };
  } else {
    const remote = await remoteFileStat(vars, runnerSessionPath);
    if (!remote) return null;
    size = remote.size;
    mtimeMs = remote.mtimeMs;
    readTail = (offset, length) => remoteReadBytes(vars, runnerSessionPath, offset, length);
  }

  const base: BudgetUsageSampleState = {
    ...pinnedIncrementalSessionUsageState(),
    path: runnerSessionPath,
    size,
    mtimeMs,
    sampledAt: new Date().toISOString(),
    baselineCaptured: true,
  };
  // An empty transcript has nothing to inherit, so count it from byte 0 — that is what
  // a zeroed `lastCumulative` means, as opposed to the pinned state's absent one.
  if (size === 0) {
    return { ...base, lastCumulative: emptyBudgetUsageSampleState().lastCumulative };
  }

  let tailStart = Math.max(0, size - BASELINE_TAIL_SCAN_BYTES);
  let tail = await readTail(tailStart, size - tailStart);
  if (!tail) return null;
  const lastNewline = tail.lastIndexOf(0x0a);
  // No record boundary within the scan window — refuse rather than guess.
  if (lastNewline < 0) return null;

  // Seed the reference from the parent's own last reading. Providers that restate
  // session totals set `lastCumulative` on every fold, so replaying the tail from a
  // reference-less state leaves exactly the reading in force at the pin; its counters
  // are partial sums and are discarded. Without this the child's first reading would be
  // spent establishing the reference, and a child whose whole turn is one record — a
  // `turn.completed` carrying 50K — would be charged nothing at all.
  let replay = replayTailReference(tail, lastNewline, tailStart, provider);
  if (replay === null) return null;

  // A defined reference is authoritative even at zero — a parent that genuinely burned
  // nothing still fixes where the session stands. Absent means the window held no
  // reading at all, which only a runner that restates totals needs to care about.
  if (replay.lastCumulative === undefined && provider.restatesSessionTotals) {
    // One large tool record can sit between the last reading and EOF. Widen once before
    // giving up, since failing here tears down a healthy retained session.
    const widenedStart = Math.max(0, size - BASELINE_TAIL_SCAN_WIDENED_BYTES);
    if (widenedStart >= tailStart) return null;
    tailStart = widenedStart;
    tail = await readTail(tailStart, size - tailStart);
    if (!tail) return null;
    replay = replayTailReference(tail, tail.lastIndexOf(0x0a), tailStart, provider);
    if (replay === null || replay.lastCumulative === undefined) return null;
  }

  // Bytes after the last boundary are the previous writer's in-flight record. It
  // completes after the pin, so drop it rather than charge their turn to this run.
  // Whitespace is not a record: discarding on a stray trailing space or newline would
  // throw away the child's genuine first record instead.
  const pinnedOffset = tailStart + lastNewline + 1;
  const trailing = tail.subarray(lastNewline + 1).toString('utf8');
  const trailingIsPartialRecord = trailing.trim().length > 0;
  return {
    ...base,
    offset: pinnedOffset,
    lastCumulative: replay.lastCumulative,
    discardNextRecord: trailingIsPartialRecord,
  };
}

/**
 * Sample session turns/tokens for the soft budget guard.
 *
 * - Supported runners use their typed session-usage provider.
 * - Unsupported runners fail closed instead of silently disabling accounting.
 * - Remote: same incremental accounting using remote seek/read of new bytes only.
 */
export async function sampleBudgetUsage(params: {
  slotId: string;
  vars: SlotVars;
  runner?: string | null;
  runnerSessionPath?: string | null;
  prior: BudgetUsageSampleState;
}): Promise<BudgetUsageSampleResult> {
  const { vars, runner, runnerSessionPath, prior } = params;
  const provider = getRunnerSessionUsageProvider(runner);
  if (!provider) {
    return unavailable(
      prior,
      `runner '${runner ?? 'unknown'}' has no bounded session-usage provider`,
      {},
      { enforcementFailure: true, unsupportedRunner: true },
    );
  }
  if (!runnerSessionPath) {
    // The path is re-resolved every poll and live discovery can come back empty for one
    // tick, so this must not disturb where counting is up to.
    return unavailable(prior, 'runner did not expose a session transcript path');
  }

  if (isLocal(vars.host, vars.machine)) {
    const result = await sampleSessionUsageIncremental({
      filePath: runnerSessionPath,
      prior,
      applyRecord: provider.applyRecord,
    });
    return {
      ...result,
      enforcementFailure: result.nextState.integrityFailureReason !== undefined,
    };
  }

  // Remote incremental path (same complete-line / oversized-skip rules as local).
  try {
    const remoteStat = await remoteFileStat(vars, runnerSessionPath);
    if (!remoteStat) {
      return unavailable(prior, 'remote transcript stat failed');
    }

    const continuityLost =
      prior.path !== null && (prior.path !== runnerSessionPath || prior.offset > remoteStat.size);
    // Accounting has started once bytes have been consumed, pin or not. Gating this on
    // `baselineCaptured` alone left cold runs unprotected once only pins set it, so a
    // rotation mid-run silently reset their counters instead of failing closed.
    if (continuityLost && (prior.baselineCaptured || prior.offset > 0)) {
      const integrityFailureReason = 'session transcript changed after budget accounting began';
      return unavailable(
        prior,
        integrityFailureReason,
        // Accounting is dead for this run once integrity is lost; the state keeps the
        // path it was actually counting so the failure stays attributable.
        {
          size: remoteStat.size,
          mtimeMs: remoteStat.mtimeMs,
          integrityFailureReason,
        },
        { enforcementFailure: true },
      );
    }

    if (
      prior.path === runnerSessionPath &&
      prior.size === remoteStat.size &&
      prior.mtimeMs === remoteStat.mtimeMs &&
      prior.offset >= remoteStat.size
    ) {
      if (prior.integrityFailureReason) {
        return unavailable(prior, prior.integrityFailureReason, {}, { enforcementFailure: true });
      }
      return {
        turns: prior.turns,
        totalTokens: prior.totalTokens,
        availability: prior.turns > 0 || prior.totalTokens > 0 ? 'cached' : 'available',
        nextState: { ...prior, sampledAt: new Date().toISOString() },
      };
    }

    // Truncation / rotate — restart accumulation.
    let state: BudgetUsageSampleState =
      prior.path === runnerSessionPath && prior.offset <= remoteStat.size
        ? { ...prior, path: runnerSessionPath, size: remoteStat.size, mtimeMs: remoteStat.mtimeMs }
        : {
            ...emptyBudgetUsageSampleState(),
            path: runnerSessionPath,
            size: remoteStat.size,
            mtimeMs: remoteStat.mtimeMs,
          };

    const start = state.offset;
    if (start >= remoteStat.size) {
      state.size = remoteStat.size;
      state.mtimeMs = remoteStat.mtimeMs;
      state.sampledAt = new Date().toISOString();
      return {
        turns: state.turns,
        totalTokens: state.totalTokens,
        availability: 'available',
        nextState: state,
      };
    }

    const unread = remoteStat.size - start;
    // windowCap is the cap, not the bytes read — see the local path.
    let windowCap = INCREMENTAL_SESSION_USAGE_MAX_BYTES_PER_SAMPLE;
    let toRead = Math.min(unread, windowCap);
    let buf = await remoteReadBytes(vars, runnerSessionPath, start, toRead);
    // Same widen-once rule as the local path: one record larger than the window would
    // otherwise be skipped with its usage uncounted.
    if (buf != null && bufferHasNoRecordBoundary(buf) && toRead === windowCap) {
      const widened = Math.min(unread, INCREMENTAL_SESSION_USAGE_MAX_OVERSIZED_BYTES);
      if (widened > toRead) {
        windowCap = INCREMENTAL_SESSION_USAGE_MAX_OVERSIZED_BYTES;
        toRead = widened;
        buf = await remoteReadBytes(vars, runnerSessionPath, start, toRead);
      }
    }
    if (buf == null) {
      return unavailable(state, 'remote transcript byte read failed');
    }

    const advanced = advanceIncrementalFromBytes(state, buf, provider.applyRecord, {
      startOffset: start,
      fileSize: remoteStat.size,
      mtimeMs: remoteStat.mtimeMs,
      filePath: runnerSessionPath,
      maxWindow: windowCap,
    });
    if (advanced.integrityFailureReason) {
      return unavailable(
        advanced,
        advanced.integrityFailureReason,
        {},
        { enforcementFailure: true },
      );
    }
    return {
      turns: advanced.turns,
      totalTokens: advanced.totalTokens,
      availability: 'available',
      nextState: advanced,
    };
  } catch (err) {
    return unavailable(prior, (err as Error).message);
  }
}
