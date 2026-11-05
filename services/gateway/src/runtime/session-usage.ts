import type { Run, RunnerSessionUsage } from '@farmslot/protocol';
import { runSessionUsage } from '@farmslot/slot-config';

import { loadSlotVars, type SlotVars } from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { forcedSessionUsageArgv } from '../runners/native-session-usage-command.js';
import { getRunnerSessionUsageProvider } from '../runners/registry.js';
import { verifiedRunnerSessionArchivePath } from '../runners/session-archive.js';

import {
  recoveredWorkerSessionReceipt,
  registerContextSessionUsage,
  upsertSessionUsage,
} from './agent-session-rows.js';
import { parseSessionUsageOutput, unavailableRunnerSessionUsage } from './session-usage-result.js';
export { parseSessionUsageOutput, unavailableRunnerSessionUsage } from './session-usage-result.js';

/** A retained transcript spans review generations, so its total is not a per-run metric. */
export function usesReviewChainSessionTotal(run: Pick<Run, 'repeatReviewContext'>): boolean {
  const continuity = run.repeatReviewContext?.session?.continuity;
  return continuity === 'resumed' || continuity === 'resume-unconfirmed';
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
      const argv = forcedSessionUsageArgv(slotId, runner, runnerSessionPath);
      const result = await execOnSlot(vars, argv.map(shellQuote).join(' '), {
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        selectNodeSupport: false,
      });
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
    ...(usage.actualModel ? { actualModel: usage.actualModel } : {}),
    ...(usage.turns != null ? { sessionTurns: usage.turns } : {}),
    ...(usage.inputTokens != null ? { sessionInputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens != null ? { sessionOutputTokens: usage.outputTokens } : {}),
    ...(usage.totalTokens != null ? { sessionTotalTokens: usage.totalTokens } : {}),
    ...(usage.cacheCreation != null ? { sessionCacheCreation: usage.cacheCreation } : {}),
    ...(usage.cacheRead != null ? { sessionCacheRead: usage.cacheRead } : {}),
    ...(usage.costUsd != null ? { costEstimate: usage.costUsd } : {}),
  };
}

async function archivedSessionUsage(
  run: Run,
  archived: string,
  session: Pick<RunnerSessionUsage, 'runnerSessionId' | 'runnerSessionPath'> = {},
): Promise<RunnerSessionUsage> {
  return parseSessionUsageOutput(
    await runSessionUsage({
      repo: '',
      slotId: run.slotId ?? run.id,
      action: 'total',
      forcedPath: archived,
      forcedRunner: run.metrics.runner,
    }),
    { runner: run.metrics.runner, ...session },
  );
}

/** Completion and family reads share the same worker-only multi-session accounting. */
export async function extractRunWorkerSessionUsage(
  run: Run,
  vars?: SlotVars,
  record?: (
    session: import('../runners/session-usage-provider.js').RecoveredUsageSession,
    usage: RunnerSessionUsage,
  ) => void,
): Promise<RunnerSessionUsage | null> {
  const slotId = run.slotId;
  if (!slotId || usesReviewChainSessionTotal(run)) return null;
  const provider = getRunnerSessionUsageProvider(run.metrics.runner);
  const sessions = await provider?.recoverSessions?.(run);
  if (!sessions?.length) return null;
  const unique = [
    ...new Map(sessions.map((session) => [session.runnerSessionPath, session])).values(),
  ];
  const slotVars = vars ?? (await loadSlotVars(slotId));
  const usages = await Promise.all(
    unique.map(async (session) => {
      const usage = await extractRunnerSessionUsage({
        slotId,
        vars: slotVars,
        runner: run.metrics.runner,
        ...session,
      });
      if (!usage.error) return usage;
      const archived = await provider?.recoverArchive?.(run, session);
      if (!archived) return usage;
      return archivedSessionUsage(run, archived, session);
    }),
  );
  usages.forEach((usage, index) => record?.(unique[index], usage));
  const failed = usages.find((usage) => usage.error || usage.totalTokens == null);
  if (failed)
    return unavailableRunnerSessionUsage({
      runner: run.metrics.runner,
      error: failed.error ?? 'Worker session usage is unavailable',
    });
  const total = (field: keyof RunnerSessionUsage): number | null => {
    const values = usages.map((usage) => usage[field]);
    return values.every((value) => typeof value === 'number')
      ? values.reduce((sum, value) => sum + value, 0)
      : null;
  };
  const cost = total('costUsd');
  return {
    ...usages[0],
    turns: total('turns'),
    inputTokens: total('inputTokens'),
    outputTokens: total('outputTokens'),
    cacheCreation: total('cacheCreation'),
    cacheRead: total('cacheRead'),
    totalTokens: total('totalTokens'),
    costUsd: cost == null ? null : Number(cost.toFixed(4)),
  };
}

/** Recover only verified retained native usage, without rewriting stored runs. */
export async function projectArchivedRunnerUsage(storedRun: Run): Promise<Run> {
  let run = storedRun;
  try {
    let workerUsage: RunnerSessionUsage | null;
    try {
      workerUsage = await extractRunWorkerSessionUsage(run, undefined, (session, usage) => {
        const rows = registerContextSessionUsage(run, run.updatedAt) ?? [];
        run = {
          ...run,
          sessionUsage: upsertSessionUsage(
            rows,
            recoveredWorkerSessionReceipt(run, session, usage),
          ),
        };
      });
    } catch (error) {
      // A recycled/offline slot cannot replace known totals or a verified archive.
      workerUsage = unavailableRunnerSessionUsage({
        runner: run.metrics.runner,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (workerUsage && !workerUsage.error)
      return {
        ...run,
        metrics: {
          ...run.metrics,
          ...runnerUsageMetrics(workerUsage),
          costEstimate: workerUsage.costUsd ?? undefined,
          sessionUsageError: workerUsage.error,
        },
      };
    if (run.metrics.sessionTotalTokens != null && run.metrics.sessionTurns != null)
      return workerUsage?.error
        ? { ...run, metrics: { ...run.metrics, sessionUsageError: workerUsage.error } }
        : run;
    const archived = await verifiedRunnerSessionArchivePath(run);
    if (!archived) {
      const reason =
        workerUsage?.error ??
        run.metrics.sessionUsageError ??
        run.metrics.runnerSessionArchive?.reason ??
        'runner did not report usage and no verified transcript was retained';
      return { ...run, metrics: { ...run.metrics, sessionUsageError: reason } };
    }
    const usage = await archivedSessionUsage(run, archived);
    // A resumed review transcript is a chain total, not this generation's usage.
    if (usesReviewChainSessionTotal(run)) return run;
    return {
      ...run,
      metrics: {
        ...runnerUsageMetrics(usage),
        ...run.metrics,
        sessionUsageError: workerUsage?.error ?? usage.error,
      },
    };
  } catch (error) {
    return { ...run, metrics: { ...run.metrics, sessionUsageError: (error as Error).message } };
  }
}

export { extractNativeAgentSessionUsage } from './native-session-usage.js';
