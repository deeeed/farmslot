// Codex rollout JSONL. Current Codex logs each executed tool item as `event_msg` /
// `item_completed` (CommandExecution, FileChange, McpToolCall, ...), the same items native Codex
// publishes as tool events, so those are the calls. In code mode one model `exec` call runs
// several of them. Rollouts without items fall back to `response_item` payloads whose type ends
// in `_call`, completed by `<type>_output` with the same call_id. Token counts are cumulative,
// so each sample is the increase.
import { pairToolEvents, type ToolCallEvent, type ToolUsageAdapter } from '../stream.js';

import { count, isoTime, isRecord, readJsonLines, text } from './jsonl.js';

/** Item types native Codex does not publish as tools (agent-runtime/src/native/codex.ts). */
const NOT_TOOLS = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan']);

function cumulativeTotal(usage: Record<string, unknown>): number {
  return usage.total_tokens != null
    ? count(usage.total_tokens)
    : count(usage.input_tokens) + count(usage.output_tokens);
}

/** `CommandExecution` -> `commandExecution`, the name the native event carries. */
function itemName(type: string): string {
  return type.charAt(0).toLowerCase() + type.slice(1);
}

/** The item's recorded start; older rollouts give only a duration, or nothing. */
function itemStart(payload: Record<string, unknown>, completedAt: string): string {
  const startedAt = isoTime(payload.started_at_ms);
  if (startedAt) return startedAt;
  const duration = isRecord(payload.item) ? payload.item.duration : undefined;
  if (!isRecord(duration)) return completedAt;
  const ms = count(duration.secs) * 1000 + count(duration.nanos) / 1e6;
  return new Date(Date.parse(completedAt) - ms).toISOString();
}

export const codexToolUsage: ToolUsageAdapter = {
  runner: 'codex',
  async read(sessionPath) {
    const items: ToolCallEvent[] = [];
    const calls: ToolCallEvent[] = [];
    const completions: Array<{ id: string; completedAt: string }> = [];
    const tokens = [];
    let previous = 0;
    for (const record of await readJsonLines(sessionPath)) {
      const payload = record.payload;
      const at = text(record.timestamp);
      if (!isRecord(payload) || !at) continue;
      const type = text(payload.type) ?? '';
      if (record.type === 'event_msg' && type === 'item_completed' && isRecord(payload.item)) {
        const name = itemName(text(payload.item.type) ?? 'unknown');
        if (!NOT_TOOLS.has(name))
          items.push({
            id: text(payload.item.id),
            name,
            issuedAt: itemStart(payload, at),
            completedAt: at,
          });
      } else if (record.type === 'response_item' && type.endsWith('_call_output')) {
        const id = text(payload.call_id);
        if (id) completions.push({ id, completedAt: at });
      } else if (record.type === 'response_item' && type.endsWith('_call')) {
        calls.push({
          id: text(payload.call_id) ?? text(payload.id),
          name: text(payload.name) ?? type,
          issuedAt: at,
        });
      } else if (record.type === 'event_msg' && type === 'token_count') {
        const info = isRecord(payload.info) ? payload.info : {};
        const usage = info.total_token_usage;
        if (!isRecord(usage)) continue;
        const total = cumulativeTotal(usage);
        if (total > previous) tokens.push({ at, tokens: total - previous });
        previous = Math.max(previous, total);
      }
    }
    return { tools: items.length ? items : pairToolEvents(calls, completions), tokens };
  },
};
