// Claude Code JSONL: assistant `tool_use` blocks; a user `tool_result` block completes one.
// One API message is split across records that repeat its usage, so usage counts once per id.
import { pairToolEvents, type ToolCallEvent, type ToolUsageAdapter } from '../stream.js';

import { count, isRecord, readJsonLines, text } from './jsonl.js';

export const claudeToolUsage: ToolUsageAdapter = {
  runner: 'claude',
  async read(sessionPath) {
    const calls: ToolCallEvent[] = [];
    const completions: Array<{ id: string; completedAt: string }> = [];
    const tokens = [];
    const callIds = new Set<string>();
    const messageIds = new Set<string>();
    for (const record of await readJsonLines(sessionPath)) {
      const message = record.message;
      const at = text(record.timestamp);
      if (!isRecord(message) || !at) continue;
      const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
      if (record.type === 'user') {
        for (const block of blocks) {
          const id = block.type === 'tool_result' ? text(block.tool_use_id) : undefined;
          if (id) completions.push({ id, completedAt: at });
        }
        continue;
      }
      if (record.type !== 'assistant') continue;
      for (const block of blocks) {
        const id = text(block.id);
        if (block.type !== 'tool_use' || (id && callIds.has(id))) continue;
        if (id) callIds.add(id);
        calls.push({ id, name: text(block.name) ?? 'unknown', issuedAt: at });
      }
      const messageId = text(message.id);
      const usage = message.usage;
      if (!isRecord(usage) || !Object.keys(usage).length) continue;
      if (messageId && messageIds.has(messageId)) continue;
      if (messageId) messageIds.add(messageId);
      tokens.push({
        at,
        tokens:
          count(usage.input_tokens) +
          count(usage.output_tokens) +
          count(usage.cache_creation_input_tokens) +
          count(usage.cache_read_input_tokens),
      });
    }
    return { tools: pairToolEvents(calls, completions), tokens };
  },
};
