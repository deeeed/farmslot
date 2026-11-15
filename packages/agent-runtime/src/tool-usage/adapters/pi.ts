// Pi session JSONL: assistant `toolCall` content blocks; a `toolResult` message completes one.
import { pairToolEvents, type ToolCallEvent, type ToolUsageAdapter } from '../stream.js';

import { count, isRecord, readJsonLines, text } from './jsonl.js';

export const piToolUsage: ToolUsageAdapter = {
  runner: 'pi',
  async read(sessionPath) {
    const calls: ToolCallEvent[] = [];
    const completions: Array<{ id: string; completedAt: string }> = [];
    const tokens = [];
    const seen = new Set<string>();
    for (const record of await readJsonLines(sessionPath)) {
      const message = record.message;
      const at = text(record.timestamp);
      if (record.type !== 'message' || !isRecord(message) || !at) continue;
      // Pi can replay an entry; its id identifies it.
      const entry = text(record.id);
      if (entry && seen.has(entry)) continue;
      if (entry) seen.add(entry);
      if (message.role === 'toolResult') {
        const id = text(message.toolCallId);
        if (id) completions.push({ id, completedAt: at });
        continue;
      }
      if (message.role !== 'assistant') continue;
      for (const block of Array.isArray(message.content) ? message.content : [])
        if (isRecord(block) && block.type === 'toolCall')
          calls.push({ id: text(block.id), name: text(block.name) ?? 'unknown', issuedAt: at });
      const usage = message.usage;
      if (isRecord(usage))
        tokens.push({
          at,
          tokens:
            count(usage.input) +
            count(usage.output) +
            count(usage.cacheRead) +
            count(usage.cacheWrite),
        });
    }
    return { tools: pairToolEvents(calls, completions), tokens };
  },
};
