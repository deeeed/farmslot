// Pi session JSONL: assistant `toolCall` blocks, completed by `toolResult` messages; each
// assistant message carries its own usage and cost; `compaction` entries mark context compactions.
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

function piParser(): StreamParser {
  const calls: ToolCallEvent[] = [];
  const completions: Array<{ id: string; completedAt: string }> = [];
  const tokens: TokenSample[] = [];
  const compactions: CompactionEvent[] = [];
  const seen = new Set<string>();
  const parsed = { tools: calls, tokens, compactions };
  return {
    push(record) {
      const message = record.message;
      const at = text(record.timestamp);
      if (record.type === 'compaction' && at) {
        // Session entry written when pi summarizes its context (auto or /compact).
        compactions.push({ at, ...tokensBefore(record.tokensBefore) });
        return;
      }
      if (record.type !== 'message' || !isRecord(message) || !at) return;
      const entry = text(record.id);
      if (entry && seen.has(entry)) return;
      if (entry) seen.add(entry);
      if (message.role === 'toolResult') {
        const id = text(message.toolCallId);
        if (id) completions.push({ id, completedAt: at });
        return;
      }
      if (message.role !== 'assistant') return;
      for (const block of Array.isArray(message.content) ? message.content : [])
        if (isRecord(block) && block.type === 'toolCall')
          calls.push({ id: text(block.id), name: text(block.name) ?? 'unknown', issuedAt: at });
      const usage = message.usage;
      if (!isRecord(usage)) return;
      const cost = isRecord(usage.cost) ? usage.cost.total : undefined;
      tokens.push({
        at,
        tokens:
          count(usage.input) +
          count(usage.output) +
          count(usage.cacheRead) +
          count(usage.cacheWrite),
        costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
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

export const piToolUsage: ToolUsageAdapter = {
  runner: 'pi',
  parser: piParser,
  async read(sessionPath) {
    const parser = piParser();
    for (const record of await readJsonLines(sessionPath)) parser.push(record);
    return parser.stream();
  },
};
