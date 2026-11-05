import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { FlowType, RunnerSessionUsage, StepLLMUsage } from '@farmslot/protocol';

export interface AgentUsageContext {
  runId: string | null;
  flowType: FlowType | null;
  role: string;
  record?: (receipt: RunnerSessionUsage) => void;
}
const ownership = new AsyncLocalStorage<AgentUsageContext>();

export function withAgentUsageContext<T>(context: AgentUsageContext, operation: () => T): T {
  return ownership.run(context, operation);
}

interface Observation {
  turns?: number;
  actualModel?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheRead?: number | null;
  cacheCreation?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
}
interface HelperAttempt {
  observations: Observation[];
  conversationId?: string;
  publish?: () => void;
}
const attempts = new AsyncLocalStorage<HelperAttempt>();

/** Called once for each structured provider terminal response, before outcome validation. */
export function observeHelperUsage(usage: Observation, conversationId?: string): void {
  const attempt = attempts.getStore();
  if (!attempt) return;
  if (conversationId) attempt.conversationId = conversationId;
  if (
    ![usage.inputTokens, usage.outputTokens, usage.totalTokens].some(
      (value) => typeof value === 'number',
    )
  ) {
    attempt.publish?.();
    return;
  }
  attempt.observations.push(usage);
  attempt.publish?.();
}

/** One shared boundary for API calls and each CLI fallback, including failed attempts. */
export async function captureHelperAttempt<
  T extends { usage: StepLLMUsage; outcome?: 'completed' | 'failed' },
>(
  config: {
    runner: string;
    model: string;
    effort?: string | null;
    role?: string;
    source: 'provider-response' | 'runner-transcript';
  },
  execute: () => Promise<T>,
): Promise<T> {
  const owner = ownership.getStore();
  const attempt: HelperAttempt = { observations: [] };
  const requestId = randomUUID();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let result: T | undefined;
  let outcome: 'completed' | 'failed' = 'failed';
  const publish = (outcome?: 'completed' | 'failed'): RunnerSessionUsage => {
    const measuredAt = new Date().toISOString();
    const total = (field: keyof Observation): number | null => {
      if (!attempt.observations.length) return null;
      let sum = 0;
      for (const observed of attempt.observations) {
        const value = observed[field];
        if (typeof value !== 'number' || !Number.isFinite(value)) return null;
        sum += value;
      }
      return sum;
    };
    const costUsd = total('costUsd');
    const gaps: string[] = [];
    if (!attempt.observations.at(-1)?.actualModel) gaps.push('Actual model is not reported');
    if (config.effort == null) gaps.push('Effective effort is not reported');
    if (!owner?.runId) gaps.push('No run owner; durable out-of-run retention is unavailable');
    if (!attempt.observations.length) gaps.push('Transport returned no structured usage');
    const receipt: RunnerSessionUsage = {
      runner: config.runner,
      model: config.model,
      actualModel: attempt.observations.at(-1)?.actualModel ?? null,
      effort: config.effort ?? null,
      role: config.role ?? owner?.role ?? 'helper',
      roles: [config.role ?? owner?.role ?? 'helper'],
      flowType: owner?.flowType ?? null,
      runId: owner?.runId ?? null,
      runnerSessionId: attempt.conversationId ?? requestId,
      requestId,
      identityKind: attempt.conversationId ? 'conversation' : 'request',
      kind: 'helper',
      turns: attempt.observations.length
        ? attempt.observations.reduce((sum, row) => sum + (row.turns ?? 1), 0)
        : null,
      inputTokens: total('inputTokens'),
      outputTokens: total('outputTokens'),
      cacheRead: total('cacheRead'),
      cacheCreation: total('cacheCreation'),
      totalTokens: total('totalTokens'),
      costUsd,
      costStatus: costUsd === null ? 'unpriced' : 'estimated',
      ...(costUsd === null
        ? { costReason: 'Provider or CLI did not supply a verified price estimate' }
        : {}),
      startedAt,
      completedAt: outcome ? measuredAt : null,
      measuredAt,
      durationMs: performance.now() - start,
      source: attempt.observations.length ? config.source : 'unavailable',
      scope: 'session-total',
      captureGaps: gaps,
      outcome,
      ...(!attempt.observations.length ? { error: 'Transport returned no structured usage' } : {}),
    };
    // Supporting telemetry must preserve the provider's original return/failure semantics.
    try {
      owner?.record?.(receipt);
    } catch {
      console.warn('[agent-usage] Receipt persistence failed');
    }
    return receipt;
  };
  attempt.publish = () => {
    publish();
  };
  publish();
  try {
    result = await attempts.run(attempt, execute);
    outcome = result.outcome ?? 'completed';
    return result;
  } finally {
    const receipt = publish(outcome);
    if (result) {
      result.usage.sessionUsage = receipt;
      result.usage.inputTokens = receipt.inputTokens ?? undefined;
      result.usage.outputTokens = receipt.outputTokens ?? undefined;
      result.usage.costUsd = receipt.costUsd ?? undefined;
      result.usage.durationMs = receipt.durationMs ?? 0;
    }
  }
}
