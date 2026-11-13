import { primaryRoleForFlow, type Run, type RunnerSessionUsage } from '@farmslot/protocol';

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
    ...(parseStringLine(lines, 'cost_reason=')
      ? { costStatus: 'unpriced', costReason: parseStringLine(lines, 'cost_reason=') ?? undefined }
      : {}),
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

/** Static reviews project a verified per-run receipt; legacy warm totals remain separate. */
export function workspaceUsageMetrics(run: Run): Run['metrics'] {
  if (!run.reviewWorkspace || run.slotId) return run.metrics;
  const context = run.agentContexts?.find(
    (entry) => entry.role === primaryRoleForFlow(run.flowType),
  );
  if (!context) return run.metrics;
  const receipt = run.sessionUsage?.find(
    (row) =>
      row.runner === context.runner &&
      row.runnerSessionId &&
      row.runnerSessionId === context.runnerSessionId,
  );
  if (!receipt) return run.metrics;
  if (usesReviewChainSessionTotal(run) && receipt.scope !== 'run-delta') return run.metrics;
  return {
    ...run.metrics,
    runnerSessionId: receipt.runnerSessionId ?? null,
    runnerSessionPath: receipt.runnerSessionPath ?? null,
    ...runnerUsageMetrics(receipt),
    ...(usesReviewChainSessionTotal(run) ? { sessionUsageScope: 'review-generation-delta' } : {}),
    sessionUsageError: receipt.error,
  };
}

/** A retained transcript spans review generations, so its total is not a per-run metric. */
export function usesReviewChainSessionTotal(run: Pick<Run, 'repeatReviewContext'>): boolean {
  const continuity = run.repeatReviewContext?.session?.continuity;
  return continuity === 'resumed' || continuity === 'resume-unconfirmed';
}
