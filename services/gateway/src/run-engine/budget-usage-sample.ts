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
  sampleSessionUsageIncremental,
} from '@farmslot/slot-config';

import type { SlotVars } from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { getRunnerSessionUsageProvider } from '../runners/registry.js';

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
 * Tail read for a warm baseline: enough to find the last record boundary and, for
 * cumulative runners, the last record carrying session totals. Codex emits a
 * `token_count` event every turn, so this window holds one except in pathological
 * transcripts — where the capture fails closed instead of guessing.
 */
const BASELINE_TAIL_SCAN_BYTES = 4 * 1024 * 1024;

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
 * Seed budget accounting at the end of a retained transcript.
 *
 * A warm handoff inherits the parent's transcript, so the child must be charged only
 * for what it appends. Replaying the parent's whole history to total it is bounded to
 * one window per sample, so on a long retained session the baseline lands far below
 * the real totals and the monitor then charges the parent's remaining bytes to the
 * child (retro 2026-08-26: run 2164728b on mini-mm-2 breached 8M "within minutes" on
 * inherited codex history). Instead this pins the last record boundary — never raw
 * EOF, which can sit inside a half-written record — after one bounded tail read.
 *
 * Cumulative runners need more than the offset: their next record restates the whole
 * session's totals, so the tail is replayed to recover the total already reached at
 * the pin. Assignment semantics make that exact from any window containing at least
 * one total-bearing record.
 *
 * Returns null when the transcript cannot be read, has no record boundary in the scan
 * window, or (for a cumulative runner) no recoverable total — callers fail the warm
 * baseline closed rather than start a run with unenforceable accounting.
 */
export async function captureBudgetUsageBaselineAtEof(params: {
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
    ...emptyBudgetUsageSampleState(),
    path: runnerSessionPath,
    size,
    mtimeMs,
    sampledAt: new Date().toISOString(),
    baselineCaptured: true,
    baselineTurns: 0,
    baselineTotalTokens: 0,
  };
  // An empty transcript needs no tail scan; offset 0 is already a record boundary.
  if (size === 0) return base;

  const tailStart = Math.max(0, size - BASELINE_TAIL_SCAN_BYTES);
  const tail = await readTail(tailStart, size - tailStart);
  if (!tail) return null;

  // Pin to the last complete record, never raw EOF: a byte offset inside a
  // half-written record makes the next sample parse the record's suffix and fail
  // accounting closed as malformed JSONL for the rest of the run.
  const lastNewline = tail.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    // No record boundary within the scan window — refuse rather than guess.
    return null;
  }
  const pinnedOffset = tailStart + lastNewline + 1;

  if (provider.tokenAccumulation === 'incremental') {
    return { ...base, offset: pinnedOffset };
  }

  // Cumulative runners (codex) report the whole session's totals on every record, so
  // the child's first record jumps straight back to the parent's total. Replay the
  // complete records in the tail to recover the total already reached at the pin;
  // assignment semantics mean the last such record wins regardless of where the
  // window starts.
  let replay: BudgetUsageSampleState = emptyBudgetUsageSampleState();
  // Keep the highest total seen, not the last. Cumulative totals only grow, while a
  // record carrying just a per-turn figure (codex falls back to `last_token_usage`
  // when `total_token_usage` is absent) would otherwise drop the baseline to that
  // small number and hand the parent's history straight back to the child.
  let peak: BudgetUsageSampleState = replay;
  for (const line of tail
    .subarray(0, lastNewline + 1)
    .toString('utf8')
    .split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      replay = provider.applyRecord(replay, JSON.parse(trimmed) as Record<string, unknown>);
      if (replay.totalTokens > peak.totalTokens) peak = replay;
    } catch {
      // A malformed record inside the parent's history cannot invalidate the child's
      // baseline: later records still carry the cumulative total we are looking for.
      continue;
    }
  }
  if (peak.totalTokens <= 0) {
    // No cumulative total in the scan window, so the parent's usage is unknown and a
    // baseline of 0 would charge the child for it. Fail closed to a fresh session.
    return null;
  }
  return {
    ...base,
    offset: pinnedOffset,
    totalTokens: peak.totalTokens,
    inputTokens: peak.inputTokens,
    outputTokens: peak.outputTokens,
    cacheRead: peak.cacheRead,
    cacheCreation: peak.cacheCreation,
    baselineTotalTokens: peak.totalTokens,
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
    const unavailableReason = `runner '${runner ?? 'unknown'}' has no bounded session-usage provider`;
    return {
      turns: null,
      totalTokens: null,
      availability: 'unavailable',
      unavailableReason,
      enforcementFailure: true,
      unsupportedRunner: true,
      nextState: {
        ...prior,
        unavailableReason,
        sampledAt: new Date().toISOString(),
      },
    };
  }
  if (!runnerSessionPath) {
    // Keep prior state. The path is re-resolved every poll and live discovery can come
    // back empty for one tick; resetting to empty state would null `path` and zero
    // `offset`, and since continuity detection needs a non-null prior path nothing
    // would fail closed — the next healthy poll would re-read the transcript from byte
    // 0 and charge the retained parent's whole history to this run.
    const next = {
      ...prior,
      unavailableReason: 'runner did not expose a session transcript path',
      sampledAt: new Date().toISOString(),
    };
    return {
      turns: null,
      totalTokens: null,
      availability: 'unavailable',
      unavailableReason: next.unavailableReason,
      nextState: next,
    };
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
      const next = {
        ...prior,
        path: runnerSessionPath,
        unavailableReason: 'remote transcript stat failed',
        sampledAt: new Date().toISOString(),
      };
      return {
        turns: null,
        totalTokens: null,
        availability: 'unavailable',
        unavailableReason: next.unavailableReason,
        nextState: next,
      };
    }

    const continuityLost =
      prior.path !== null && (prior.path !== runnerSessionPath || prior.offset > remoteStat.size);
    if (continuityLost && prior.baselineCaptured) {
      const integrityFailureReason = 'session transcript changed after budget accounting began';
      return {
        turns: null,
        totalTokens: null,
        availability: 'unavailable',
        unavailableReason: integrityFailureReason,
        enforcementFailure: true,
        nextState: {
          ...prior,
          path: runnerSessionPath,
          size: remoteStat.size,
          mtimeMs: remoteStat.mtimeMs,
          integrityFailureReason,
          unavailableReason: integrityFailureReason,
          sampledAt: new Date().toISOString(),
        },
      };
    }

    if (
      prior.path === runnerSessionPath &&
      prior.size === remoteStat.size &&
      prior.mtimeMs === remoteStat.mtimeMs &&
      prior.offset >= remoteStat.size
    ) {
      if (prior.integrityFailureReason) {
        return {
          turns: null,
          totalTokens: null,
          availability: 'unavailable',
          unavailableReason: prior.integrityFailureReason,
          enforcementFailure: true,
          nextState: { ...prior, sampledAt: new Date().toISOString() },
        };
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
      const next = {
        ...state,
        unavailableReason: 'remote transcript byte read failed',
        sampledAt: new Date().toISOString(),
      };
      return {
        turns: null,
        totalTokens: null,
        availability: 'unavailable',
        unavailableReason: next.unavailableReason,
        nextState: next,
      };
    }

    const advanced = advanceIncrementalFromBytes(state, buf, provider.applyRecord, {
      startOffset: start,
      fileSize: remoteStat.size,
      mtimeMs: remoteStat.mtimeMs,
      filePath: runnerSessionPath,
      maxWindow: windowCap,
    });
    if (advanced.integrityFailureReason) {
      return {
        turns: null,
        totalTokens: null,
        availability: 'unavailable',
        unavailableReason: advanced.integrityFailureReason,
        enforcementFailure: true,
        nextState: advanced,
      };
    }
    return {
      turns: advanced.turns,
      totalTokens: advanced.totalTokens,
      availability: 'available',
      nextState: advanced,
    };
  } catch (err) {
    const next = {
      ...prior,
      path: runnerSessionPath,
      unavailableReason: (err as Error).message,
      sampledAt: new Date().toISOString(),
    };
    return {
      turns: null,
      totalTokens: null,
      availability: 'unavailable',
      unavailableReason: next.unavailableReason,
      nextState: next,
    };
  }
}
