// Claude Code session JSONL: assistant `tool_use` blocks, completed by user `tool_result` blocks.
// One API message spans several records, so usage counts once per message id. `compact_boundary`
// system records mark context compactions. Cost is priced from the static table by model.
import { CLAUDE_PRICING } from '../prices.js';
import {
  type CompactionEvent,
  dropStreamBefore,
  pairToolEvents,
  type StreamParser,
  type TokenSample,
  type ToolCallEvent,
  type ToolUsageAdapter,
} from '../stream.js';

import { count, isRecord, readJsonLines, text, tokensBefore } from './jsonl.js';

function claudeCost(model: string | undefined, usage: Record<string, unknown>): number | null {
  const prices = model
    ? Object.entries(CLAUDE_PRICING).find(([key]) => model.includes(key))?.[1]
    : undefined;
  if (!prices) return null;
  return (
    (count(usage.input_tokens) * prices.input +
      count(usage.output_tokens) * prices.output +
      count(usage.cache_creation_input_tokens) * prices.cache_write +
      count(usage.cache_read_input_tokens) * prices.cache_read) /
    1_000_000
  );
}

function claudeParser(): StreamParser {
  const calls: ToolCallEvent[] = [];
  const completions: Array<{ id: string; completedAt: string }> = [];
  const tokens: TokenSample[] = [];
  const compactions: CompactionEvent[] = [];
  const callIds = new Set<string>();
  const messageIds = new Set<string>();
  const parsed = { tools: calls, tokens, compactions };
  return {
    push(record) {
      const message = record.message;
      const at = text(record.timestamp);
      if (record.type === 'system' && record.subtype === 'compact_boundary' && at) {
        const meta = isRecord(record.compactMetadata) ? record.compactMetadata : {};
        compactions.push({ at, ...tokensBefore(meta.preTokens) });
        return;
      }
      if (!isRecord(message) || !at) return;
      const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
      if (record.type === 'user') {
        for (const block of blocks) {
          const id = block.type === 'tool_result' ? text(block.tool_use_id) : undefined;
          if (id) completions.push({ id, completedAt: at });
        }
        return;
      }
      if (record.type !== 'assistant') return;
      for (const block of blocks) {
        const id = text(block.id);
        if (block.type !== 'tool_use' || (id && callIds.has(id))) continue;
        if (id) callIds.add(id);
        calls.push({ id, name: text(block.name) ?? 'unknown', issuedAt: at });
      }
      const messageId = text(message.id);
      const usage = message.usage;
      if (!isRecord(usage) || !Object.keys(usage).length) return;
      if (messageId && messageIds.has(messageId)) return;
      if (messageId) messageIds.add(messageId);
      tokens.push({
        at,
        tokens:
          count(usage.input_tokens) +
          count(usage.output_tokens) +
          count(usage.cache_creation_input_tokens) +
          count(usage.cache_read_input_tokens),
        costUsd: claudeCost(text(message.model), usage),
      });
    },
    stream() {
      pairToolEvents(calls, completions);
      return parsed;
    },
    dropBefore(time) {
      pairToolEvents(calls, completions);
      completions.length = 0;
      dropStreamBefore(parsed, time);
    },
  };
}

export const claudeToolUsage: ToolUsageAdapter = {
  runner: 'claude',
  parser: claudeParser,
  async read(sessionPath) {
    const parser = claudeParser();
    for (const record of await readJsonLines(sessionPath)) parser.push(record);
    return parser.stream();
  },
};
