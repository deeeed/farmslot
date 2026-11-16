// Codex rollout JSONL. Current Codex logs each executed tool item as `event_msg` /
// `item_completed` (CommandExecution, FileChange, McpToolCall, ...), the same items native Codex
// publishes as tool events, so those are the calls. In code mode one model `exec` call runs
// several of them. Rollouts without items fall back to `response_item` payloads whose type ends
// in `_call`, completed by `<type>_output` with the same call_id. Token counts are cumulative,
// so each sample is the increase, priced from the static table by the turn's model. Each
// context compaction is one top-level `compacted` record.
import { OPENAI_PRICING } from '../prices.js';
import {
  type CompactionEvent,
  dropStreamBefore,
  pairToolEvents,
  type StreamParser,
  type TokenSample,
  type ToolCallEvent,
  type ToolUsageAdapter,
} from '../stream.js';

import { count, isoTime, isRecord, readJsonLines, text } from './jsonl.js';

/** Item types native Codex does not publish as tools (agent-runtime/src/native/codex.ts). */
const NOT_TOOLS = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction']);

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

function codexParser(): StreamParser {
  const items: ToolCallEvent[] = [];
  const calls: ToolCallEvent[] = [];
  const completions: Array<{ id: string; completedAt: string }> = [];
  const tokens: TokenSample[] = [];
  const compactions: CompactionEvent[] = [];
  let model: string | undefined;
  let previous = { total: 0, input: 0, output: 0 };
  const parsed = { tools: items, tokens, compactions };
  const current = () => ({
    tools: items.length ? items : pairToolEvents(calls, completions),
    tokens,
    compactions,
  });
  return {
    push(record) {
      const payload = record.payload;
      const at = text(record.timestamp);
      if (record.type === 'compacted' && at) {
        compactions.push({ at });
        return;
      }
      if (!isRecord(payload) || !at) return;
      const type = text(payload.type) ?? '';
      if (record.type === 'turn_context') {
        model = text(payload.model) ?? model;
      } else if (record.type === 'event_msg' && type === 'item_completed' && isRecord(payload.item)) {
        const name = itemName(text(payload.item.type) ?? 'unknown');
        if (!NOT_TOOLS.has(name))
          items.push({ id: text(payload.item.id), name, issuedAt: itemStart(payload, at), completedAt: at });
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
        if (!isRecord(usage)) return;
        const total = cumulativeTotal(usage);
        if (total > previous.total) {
          const prices = model
            ? Object.entries(OPENAI_PRICING).find(([key]) => model!.startsWith(key))?.[1]
            : undefined;
          const input = Math.max(0, count(usage.input_tokens) - previous.input);
          const output = Math.max(0, count(usage.output_tokens) - previous.output);
          tokens.push({
            at,
            tokens: total - previous.total,
            costUsd: prices ? (input * prices.input + output * prices.output) / 1_000_000 : null,
          });
        }
        previous = {
          total: Math.max(previous.total, total),
          input: Math.max(previous.input, count(usage.input_tokens)),
          output: Math.max(previous.output, count(usage.output_tokens)),
        };
      }
    },
    stream: current,
    dropBefore(time) {
      pairToolEvents(calls, completions);
      completions.length = 0;
      dropStreamBefore(parsed, time);
      dropStreamBefore({ tools: calls, tokens: null, compactions: null }, time);
    },
  };
}

export const codexToolUsage: ToolUsageAdapter = {
  runner: 'codex',
  parser: codexParser,
  async read(sessionPath) {
    const parser = codexParser();
    for (const record of await readJsonLines(sessionPath)) parser.push(record);
    return parser.stream();
  },
};
