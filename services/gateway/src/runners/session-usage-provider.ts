import type { IncrementalSessionUsageState } from '@farmslot/slot-config';

export interface RunnerSessionUsageProvider {
  readonly id: string;
  applyRecord(
    state: IncrementalSessionUsageState,
    record: Record<string, unknown>,
  ): IncrementalSessionUsageState;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function claudeApplyRecord(
  state: IncrementalSessionUsageState,
  record: Record<string, unknown>,
): IncrementalSessionUsageState {
  if (record.type !== 'assistant') return state;
  const message = record.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!usage) return state;

  const next = { ...state, turns: state.turns + 1 };
  next.inputTokens += finiteNumber(usage.input_tokens) ?? 0;
  next.outputTokens += finiteNumber(usage.output_tokens) ?? 0;
  next.cacheCreation += finiteNumber(usage.cache_creation_input_tokens) ?? 0;
  next.cacheRead += finiteNumber(usage.cache_read_input_tokens) ?? 0;
  next.totalTokens = next.inputTokens + next.outputTokens + next.cacheCreation + next.cacheRead;
  return next;
}

function codexUsageTotal(usage: Record<string, unknown>): number {
  const explicit = finiteNumber(usage.total_tokens);
  if (explicit !== null) return explicit;
  return (finiteNumber(usage.input_tokens) ?? 0) + (finiteNumber(usage.output_tokens) ?? 0);
}

function codexApplyRecord(
  state: IncrementalSessionUsageState,
  record: Record<string, unknown>,
): IncrementalSessionUsageState {
  const next = { ...state };
  const payload = (record.payload as Record<string, unknown> | undefined) ?? {};

  if (
    record.type === 'response_item' &&
    payload.type === 'message' &&
    payload.role === 'assistant'
  ) {
    next.turns += 1;
  } else if (record.type === 'turn.completed' && record.usage) {
    next.turns += 1;
    const usage = record.usage as Record<string, unknown>;
    next.inputTokens = finiteNumber(usage.input_tokens) ?? next.inputTokens;
    next.outputTokens = finiteNumber(usage.output_tokens) ?? next.outputTokens;
    next.totalTokens = codexUsageTotal(usage);
  } else if (record.type === 'event_msg' && payload.type === 'token_count') {
    const info = (payload.info as Record<string, unknown> | undefined) ?? {};
    const usage = (info.total_token_usage ?? info.last_token_usage) as
      | Record<string, unknown>
      | undefined;
    if (usage) {
      next.inputTokens = finiteNumber(usage.input_tokens) ?? next.inputTokens;
      next.outputTokens = finiteNumber(usage.output_tokens) ?? next.outputTokens;
      next.cacheRead = finiteNumber(usage.cached_input_tokens) ?? next.cacheRead;
      next.totalTokens = codexUsageTotal(usage);
    }
  }
  return next;
}

export const claudeSessionUsageProvider: RunnerSessionUsageProvider = {
  id: 'claude-jsonl',
  applyRecord: claudeApplyRecord,
};

export const codexSessionUsageProvider: RunnerSessionUsageProvider = {
  id: 'codex-jsonl',
  applyRecord: codexApplyRecord,
};
