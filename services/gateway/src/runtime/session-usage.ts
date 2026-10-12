import type { Run, RunnerSessionUsage } from '@farmslot/protocol';
import { expandTemplate, runSessionUsage } from '@farmslot/slot-config';

import type { SlotVars } from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { verifiedRunnerSessionArchivePath } from '../runners/session-archive.js';

function parseNumberLine(lines: string[], prefix: string): number | null {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  if (!line) return null;
  const n = Number.parseFloat(line.split('=')[1] ?? '');
  return Number.isFinite(n) ? n : null;
}

function parseStringLine(lines: string[], prefix: string): string | null {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  if (!line) return null;
  const value = line.slice(prefix.length).trim();
  return value && value !== 'unknown' ? value : null;
}

/** A retained transcript spans review generations, so its total is not a per-run metric. */
export function usesReviewChainSessionTotal(run: Pick<Run, 'repeatReviewContext'>): boolean {
  const continuity = run.repeatReviewContext?.session?.continuity;
  return continuity === 'resumed' || continuity === 'resume-unconfirmed';
}

export function parseSessionUsageOutput(
  stdout: string,
  seed: Pick<RunnerSessionUsage, 'runner' | 'runnerSessionId' | 'runnerSessionPath'> = {},
): RunnerSessionUsage {
  const lines = stdout.split('\n');
  return {
    ...seed,
    actualModel: parseStringLine(lines, 'model='),
    turns: parseNumberLine(lines, 'turns='),
    inputTokens: parseNumberLine(lines, 'input_tokens='),
    outputTokens: parseNumberLine(lines, 'output_tokens='),
    cacheCreation: parseNumberLine(lines, 'cache_creation='),
    cacheRead: parseNumberLine(lines, 'cache_read='),
    reasoningOutputTokens: parseNumberLine(lines, 'reasoning_output_tokens='),
    totalTokens: parseNumberLine(lines, 'total_tokens='),
    costUsd: parseNumberLine(lines, 'cost_usd='),
    measuredAt: new Date().toISOString(),
    source: 'runner-transcript',
    scope: 'session-total',
  };
}

export function unavailableRunnerSessionUsage({
  runner,
  runnerSessionId,
  runnerSessionPath,
  error,
}: {
  runner?: string | null;
  runnerSessionId?: string | null;
  runnerSessionPath?: string | null;
  error: string;
}): RunnerSessionUsage {
  return {
    runner: runner ?? null,
    runnerSessionId: runnerSessionId ?? null,
    runnerSessionPath: runnerSessionPath ?? null,
    measuredAt: new Date().toISOString(),
    source: 'unavailable',
    error,
  };
}

export async function extractRunnerSessionUsage({
  slotId,
  vars,
  runner,
  runnerSessionId,
  runnerSessionPath,
}: {
  slotId: string;
  vars?: SlotVars;
  runner?: string | null;
  runnerSessionId?: string | null;
  runnerSessionPath?: string | null;
}): Promise<RunnerSessionUsage> {
  if (!runnerSessionPath) {
    return unavailableRunnerSessionUsage({
      runner,
      runnerSessionId,
      runnerSessionPath: null,
      error: 'runner did not expose a session transcript path',
    });
  }
  try {
    if (vars && !isLocal(vars.host, vars.machine)) {
      const farmslotDir = expandTemplate('{{farmslot_dir}}', vars);
      const result = await execOnSlot(
        vars,
        `RUNNER_SESSION_PATH=${shellQuote(runnerSessionPath)} RUNNER_SESSION_RUNNER=${shellQuote(runner ?? '')} bash ${farmslotDir}/scripts/session-usage.sh ${shellQuote(slotId)} total`,
        { timeout: 30_000, maxBuffer: 64 * 1024, selectNodeSupport: false },
      );
      if (result.exitCode !== 0)
        throw new Error(result.stderr.trim() || `Usage extraction exited ${result.exitCode}`);
      return parseSessionUsageOutput(result.stdout, { runner, runnerSessionId, runnerSessionPath });
    }
    const output = await runSessionUsage({
      // repo is unused when forcedPath is set; pass empty string.
      repo: '',
      slotId,
      action: 'total',
      forcedPath: runnerSessionPath,
      forcedRunner: runner ?? null,
    });
    return parseSessionUsageOutput(output, {
      runner: runner ?? null,
      runnerSessionId: runnerSessionId ?? null,
      runnerSessionPath,
    });
  } catch (err) {
    return unavailableRunnerSessionUsage({
      runner,
      runnerSessionId,
      runnerSessionPath,
      error: (err as Error).message,
    });
  }
}

/** The same metric mapping feeds completion capture and historical read projection. */
export function runnerUsageMetrics(usage: RunnerSessionUsage): Partial<Run['metrics']> {
  return {
    ...(usage.turns != null ? { sessionTurns: usage.turns } : {}),
    ...(usage.inputTokens != null ? { sessionInputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens != null ? { sessionOutputTokens: usage.outputTokens } : {}),
    ...(usage.totalTokens != null ? { sessionTotalTokens: usage.totalTokens } : {}),
    ...(usage.cacheCreation != null ? { sessionCacheCreation: usage.cacheCreation } : {}),
    ...(usage.cacheRead != null ? { sessionCacheRead: usage.cacheRead } : {}),
    ...(usage.costUsd != null ? { costEstimate: usage.costUsd } : {}),
  };
}

/** Recover only verified retained native usage, without rewriting stored runs. */
export async function projectArchivedRunnerUsage(run: Run): Promise<Run> {
  if (run.metrics.sessionTotalTokens != null && run.metrics.sessionTurns != null) return run;
  try {
    const archived = await verifiedRunnerSessionArchivePath(run);
    if (!archived) {
      const reason =
        run.metrics.sessionUsageError ??
        run.metrics.runnerSessionArchive?.reason ??
        'runner did not report usage and no verified transcript was retained';
      return { ...run, metrics: { ...run.metrics, sessionUsageError: reason } };
    }
    const output = await runSessionUsage({
      repo: '',
      slotId: run.slotId ?? run.id,
      action: 'total',
      forcedPath: archived,
      forcedRunner: run.metrics.runner,
    });
    const usage = parseSessionUsageOutput(output);
    // A resumed review transcript is a chain total, not this generation's usage.
    if (usesReviewChainSessionTotal(run)) return run;
    return {
      ...run,
      metrics: { ...runnerUsageMetrics(usage), ...run.metrics, sessionUsageError: usage.error },
    };
  } catch (error) {
    return { ...run, metrics: { ...run.metrics, sessionUsageError: (error as Error).message } };
  }
}
