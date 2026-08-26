import type { IncrementalSessionUsageState } from '@farmslot/slot-config';

/**
 * Runner-specific transcript accounting.
 *
 * Every provider must report usage as an **increment** on the state it is given, so
 * counters started at any byte offset measure exactly the work after that offset.
 * Runners that restate session totals (codex) convert to increments here — that is the
 * runner's own semantics and belongs behind its provider, not in the budget guard.
 */
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

/**
 * Fold one codex session-total reading into the running counters as an increment.
 *
 * `lastCumulative` is the previous reading. When it is absent the counters were started
 * mid-transcript (a warm-handoff pin), so this reading only establishes the reference —
 * everything it covers belongs to whoever wrote the transcript before the pin. That
 * forfeits whatever the run did before its first reading, which codex emits several
 * times per turn, so the loss is a fraction of one turn and always in the safe
 * direction: it can under-charge a run, never charge it for someone else's history.
 *
 * Readings are clamped at zero so a `last_token_usage` fallback, which reports one turn
 * rather than the session, cannot subtract from the totals.
 */
function foldCodexSessionTotals(
  state: IncrementalSessionUsageState,
  usage: Record<string, unknown>,
): IncrementalSessionUsageState {
  const reading = {
    input: finiteNumber(usage.input_tokens) ?? 0,
    output: finiteNumber(usage.output_tokens) ?? 0,
    cacheRead: finiteNumber(usage.cached_input_tokens) ?? 0,
    total: codexUsageTotal(usage),
  };
  const previous = state.lastCumulative;
  const next = { ...state, lastCumulative: reading };
  if (!previous) return next;
  next.inputTokens += Math.max(0, reading.input - previous.input);
  next.outputTokens += Math.max(0, reading.output - previous.output);
  next.cacheRead += Math.max(0, reading.cacheRead - previous.cacheRead);
  next.totalTokens += Math.max(0, reading.total - previous.total);
  return next;
}

function codexApplyRecord(
  state: IncrementalSessionUsageState,
  record: Record<string, unknown>,
): IncrementalSessionUsageState {
  const payload = (record.payload as Record<string, unknown> | undefined) ?? {};

  if (
    record.type === 'response_item' &&
    payload.type === 'message' &&
    payload.role === 'assistant'
  ) {
    return { ...state, turns: state.turns + 1 };
  }
  if (record.type === 'turn.completed' && record.usage) {
    const folded = foldCodexSessionTotals(state, record.usage as Record<string, unknown>);
    return { ...folded, turns: folded.turns + 1 };
  }
  if (record.type === 'event_msg' && payload.type === 'token_count') {
    const info = (payload.info as Record<string, unknown> | undefined) ?? {};
    const usage = (info.total_token_usage ?? info.last_token_usage) as
      | Record<string, unknown>
      | undefined;
    if (usage) return foldCodexSessionTotals(state, usage);
  }
  return state;
}

export const claudeSessionUsageProvider: RunnerSessionUsageProvider = {
  id: 'claude-jsonl',
  applyRecord: claudeApplyRecord,
};

export const codexSessionUsageProvider: RunnerSessionUsageProvider = {
  id: 'codex-jsonl',
  applyRecord: codexApplyRecord,
};
