import {
  primaryRoleForFlow,
  type Run,
  type RunnerSessionUsage,
  type SessionToolUsage,
} from '@farmslot/protocol';

import { REMOTE_USAGE_DETAIL_NOTE } from '../runners/native-session-usage-command.js';

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

/** The accounting module's `tool_usage=` JSON line; absent from older node modules. */
function parseToolUsage(lines: string[]): Pick<RunnerSessionUsage, 'toolUsage' | 'toolUsageError'> {
  const error = parseStringLine(lines, 'tool_usage_error=');
  if (error) return { toolUsageError: error };
  const line = lines.find((candidate) => candidate.startsWith('tool_usage='));
  if (!line) return {};
  const value: unknown = JSON.parse(line.slice('tool_usage='.length));
  if (
    !value ||
    typeof value !== 'object' ||
    !('toolCalls' in value) ||
    typeof value.toolCalls !== 'number' ||
    !('steps' in value) ||
    !Array.isArray(value.steps)
  )
    return { toolUsageError: 'Accounting returned malformed tool usage' };
  return { toolUsage: value as SessionToolUsage };
}

export function parseSessionUsageOutput(
  stdout: string,
  seed: Pick<
    RunnerSessionUsage,
    'runner' | 'runnerSessionId' | 'runnerSessionPath' | 'pricingScope'
  > = {},
): RunnerSessionUsage {
  const lines = stdout.split('\n');
  const providerReportedCostUsd = parseNumberLine(lines, 'provider_reported_cost_usd=');
  const toolUsage = parseToolUsage(lines);
  // Pi's default breakdown contains SDK amounts without verified pricing provenance.
  if (seed.pricingScope === 'remote-tmux-pi' && toolUsage.toolUsage) {
    for (const step of toolUsage.toolUsage.steps) {
      if (step && typeof step === 'object') step.costUsd = null;
    }
  }
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
    ...(providerReportedCostUsd === null ? {} : { providerReportedCostUsd }),
    ...(parseStringLine(lines, 'cost_reason=')
      ? { costStatus: 'unpriced', costReason: parseStringLine(lines, 'cost_reason=') ?? undefined }
      : {}),
    ...toolUsage,
    ...(lines.includes('receipt_detail_limited=yes')
      ? { captureGaps: [REMOTE_USAGE_DETAIL_NOTE] }
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
    ...(usage.toolUsage ? { sessionToolCalls: usage.toolUsage.toolCalls } : {}),
    ...(usage.toolUsage?.toolCallsBeforeFirstMark != null
      ? { sessionToolCallsBeforeFirstMark: usage.toolUsage.toolCallsBeforeFirstMark }
      : {}),
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
    // A successful remote Pi measurement supersedes an earlier unsafe estimate.
    ...(receipt.pricingScope === 'remote-tmux-pi' &&
    receipt.source === 'runner-transcript' &&
    !receipt.error &&
    receipt.costStatus === 'unpriced'
      ? { costEstimate: undefined }
      : {}),
    ...(usesReviewChainSessionTotal(run) ? { sessionUsageScope: 'review-generation-delta' } : {}),
    sessionUsageError: receipt.error,
  };
}

/** A retained transcript spans review generations, so its total is not a per-run metric. */
export function usesReviewChainSessionTotal(run: Pick<Run, 'repeatReviewContext'>): boolean {
  const continuity = run.repeatReviewContext?.session?.continuity;
  return continuity === 'resumed' || continuity === 'resume-unconfirmed';
}
