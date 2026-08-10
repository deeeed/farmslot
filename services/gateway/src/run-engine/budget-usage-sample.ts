// budget-usage-sample.ts — Gateway wrapper around shared session-usage sampling
// for the soft turn/token budget guard.
//
// Local + remote: bounded incremental complete-line sampling (shared advance
// helper). Remote reads only new bytes from the durable offset via a short
// Python seek/read on the slot (no full-transcript reparse on each poll).

import {
  advanceIncrementalFromBytes,
  emptyIncrementalSessionUsageState,
  INCREMENTAL_SESSION_USAGE_MAX_BYTES_PER_SAMPLE,
  type IncrementalSessionUsageState,
  sampleSessionUsageIncremental,
} from '@farmslot/slot-config';

import type { SlotVars } from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';

/** Durable monitor sample state (also persisted on Run.monitorState). */
export type BudgetUsageSampleState = IncrementalSessionUsageState;

export type BudgetUsageSampleResult = {
  turns: number | null;
  totalTokens: number | null;
  availability: 'available' | 'unavailable' | 'cached';
  unavailableReason?: string;
  nextState: BudgetUsageSampleState;
};

export function emptyBudgetUsageSampleState(): BudgetUsageSampleState {
  return emptyIncrementalSessionUsageState();
}

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

/** Build a remote bash script path argument that expands `~/` via `$HOME`. */
export function remoteSessionUsageScriptArg(script: string): string {
  if (script.startsWith('~/')) {
    return `"$HOME/${script.slice(2).replace(/"/g, '\\"')}"`;
  }
  return shellQuote(script);
}

/**
 * Sample session turns/tokens for the soft budget guard.
 *
 * - Local: shared incremental complete-line sampler (bounded new-byte window).
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
  if (!runnerSessionPath) {
    const next = {
      ...emptyBudgetUsageSampleState(),
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
    return sampleSessionUsageIncremental({
      filePath: runnerSessionPath,
      runner,
      prior,
    });
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

    if (
      prior.path === runnerSessionPath &&
      prior.size === remoteStat.size &&
      prior.mtimeMs === remoteStat.mtimeMs &&
      prior.offset >= remoteStat.size
    ) {
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

    const toRead = Math.min(
      remoteStat.size - start,
      INCREMENTAL_SESSION_USAGE_MAX_BYTES_PER_SAMPLE,
    );
    const buf = await remoteReadBytes(vars, runnerSessionPath, start, toRead);
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

    const advanced = advanceIncrementalFromBytes(state, buf, runner, {
      startOffset: start,
      fileSize: remoteStat.size,
      mtimeMs: remoteStat.mtimeMs,
      filePath: runnerSessionPath,
      maxWindow: INCREMENTAL_SESSION_USAGE_MAX_BYTES_PER_SAMPLE,
    });
    if (advanced.unavailableReason) {
      return {
        turns: null,
        totalTokens: null,
        availability: 'unavailable',
        unavailableReason: advanced.unavailableReason,
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
