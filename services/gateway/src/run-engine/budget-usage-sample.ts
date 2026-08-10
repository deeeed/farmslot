// budget-usage-sample.ts — Gateway wrapper around shared session-usage sampling
// for the soft turn/token budget guard.
//
// Local: packages/slot-config sampleSessionUsageIncremental (complete-line offset).
// Remote: session-usage.sh via execOnSlot with remote farmslot-node / remoteRepo
//         path candidates (never assume the gateway host path exists on the slot).

import {
  emptyIncrementalSessionUsageState,
  type IncrementalSessionUsageState,
  sampleSessionUsageIncremental,
} from '@farmslot/slot-config';

import type { SlotVars } from '../core/config.js';
import { farmslotRoot } from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { parseSessionUsageOutput } from '../runtime/session-usage.js';

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

/** Remote agent install root used by slot hooks (see packages/slot-config hooks). */
const REMOTE_FARMSLOT_DIR = '~/farmslot-node';

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

function remoteSessionUsageScriptCandidates(vars: SlotVars): string[] {
  const candidates: string[] = [];
  // Prefer the deployed agent tree on remote nodes (hooks use the same root).
  candidates.push(`${REMOTE_FARMSLOT_DIR}/scripts/session-usage.sh`);
  // Slot worktree checkout when scripts are vendored with the repo.
  if (vars.remoteRepo) {
    candidates.push(`${vars.remoteRepo}/scripts/session-usage.sh`);
  }
  // Last resort: same absolute path as the gateway host (shared NFS layouts).
  candidates.push(`${farmslotRoot}/scripts/session-usage.sh`);
  return candidates;
}

/** Build a remote bash script path argument that expands `~/` via `$HOME`. */
export function remoteSessionUsageScriptArg(script: string): string {
  if (script.startsWith('~/')) {
    return `"$HOME/${script.slice(2).replace(/"/g, '\\"')}"`;
  }
  return shellQuote(script);
}

async function remoteSessionUsageTotal(
  vars: SlotVars,
  slotId: string,
  runnerSessionPath: string,
  runner: string | null | undefined,
): Promise<{ turns: number | null; totalTokens: number | null; error?: string }> {
  const env = [
    `RUNNER_SESSION_PATH=${shellQuote(runnerSessionPath)}`,
    runner ? `RUNNER_SESSION_RUNNER=${shellQuote(runner)}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const errors: string[] = [];
  for (const script of remoteSessionUsageScriptCandidates(vars)) {
    const cmd = `${env} bash ${remoteSessionUsageScriptArg(script)} ${shellQuote(slotId)} total 2>&1`;
    const result = await execOnSlot(vars, cmd);
    if (result.exitCode === 0 && result.stdout.trim()) {
      const usage = parseSessionUsageOutput(result.stdout, {
        runner: runner ?? null,
        runnerSessionPath,
      });
      return {
        turns: usage.turns ?? null,
        totalTokens: usage.totalTokens ?? null,
      };
    }
    errors.push(
      `${script}: exit ${result.exitCode} ${result.stdout.replace(/\s+/g, ' ').slice(0, 120)}`,
    );
  }
  return {
    turns: null,
    totalTokens: null,
    error: `remote session-usage failed (${errors.join(' | ')})`,
  };
}

/**
 * Sample session turns/tokens for the soft budget guard.
 *
 * - Local: shared incremental complete-line sampler (no full re-read; incomplete
 *   trailing JSONL does not advance the durable offset).
 * - Remote: session-usage.sh via execOnSlot with remote path candidates; skipped
 *   when size/mtime unchanged.
 */
export async function sampleBudgetUsage(params: {
  slotId: string;
  vars: SlotVars;
  runner?: string | null;
  runnerSessionPath?: string | null;
  prior: BudgetUsageSampleState;
}): Promise<BudgetUsageSampleResult> {
  const { slotId, vars, runner, runnerSessionPath, prior } = params;
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

  // Remote: size/mtime cache then full session-usage on the slot.
  try {
    const remoteStat = await remoteFileStat(vars, runnerSessionPath);
    if (
      remoteStat &&
      prior.path === runnerSessionPath &&
      prior.size === remoteStat.size &&
      prior.mtimeMs === remoteStat.mtimeMs &&
      (prior.turns > 0 || prior.totalTokens > 0)
    ) {
      return {
        turns: prior.turns,
        totalTokens: prior.totalTokens,
        availability: 'cached',
        nextState: { ...prior, sampledAt: new Date().toISOString() },
      };
    }

    const usage = await remoteSessionUsageTotal(vars, slotId, runnerSessionPath, runner);
    if (usage.error) {
      const next = {
        ...emptyBudgetUsageSampleState(),
        path: runnerSessionPath,
        size: remoteStat?.size ?? 0,
        mtimeMs: remoteStat?.mtimeMs ?? 0,
        unavailableReason: usage.error,
        sampledAt: new Date().toISOString(),
      };
      return {
        turns: null,
        totalTokens: null,
        availability: 'unavailable',
        unavailableReason: usage.error,
        nextState: next,
      };
    }

    const next: BudgetUsageSampleState = {
      path: runnerSessionPath,
      size: remoteStat?.size ?? 0,
      mtimeMs: remoteStat?.mtimeMs ?? 0,
      offset: remoteStat?.size ?? 0,
      turns: usage.turns ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreation: 0,
      cacheRead: 0,
      sampledAt: new Date().toISOString(),
    };
    return {
      turns: usage.turns,
      totalTokens: usage.totalTokens,
      availability: 'available',
      nextState: next,
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
