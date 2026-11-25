// ADR-039 Amendment 10: export formats. Claude Code, Codex and Pi stay native JSONL; Grok
// becomes the Session Trace Simple Format; export prices tokens a run did not price.
import { CLAUDE_PRICING, OPENAI_PRICING, openaiCostUsd } from '@farmslot/agent-runtime/tool-usage';

type JsonRecord = Record<string, unknown>;

const STS_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : part && typeof part === 'object' && typeof (part as JsonRecord).text === 'string'
            ? ((part as JsonRecord).text as string)
            : '',
      )
      .filter(Boolean)
      .join('\n');
  return undefined;
}

/**
 * Grok `chat_history.jsonl` → Session Trace Simple Format: a session header, then one message per
 * turn. The header name is the run id, never task text. Unmappable records are counted.
 */
export function grokToSessionTrace(input: {
  lines: string[];
  runId: string;
  sessionId: string;
  runner: string;
}): { lines: string[]; unmapped: number } {
  const out = [
    JSON.stringify({
      type: 'session',
      harness: `farmslot-${input.runner}`,
      id: input.sessionId,
      name: input.runId,
    }),
  ];
  let unmapped = 0;
  for (const line of input.lines) {
    if (!line.trim()) continue;
    let record: JsonRecord;
    try {
      record = JSON.parse(line) as JsonRecord;
    } catch {
      unmapped += 1;
      continue;
    }
    const role = String(record.role ?? record.type ?? '');
    const content = contentText(record.content ?? record.message ?? record.text);
    if (!STS_ROLES.has(role) || content === undefined) {
      unmapped += 1;
      continue;
    }
    const timestamp = record.timestamp ?? record.created_at;
    out.push(
      JSON.stringify({
        type: 'message',
        message: {
          role,
          content,
          ...(typeof record.reasoning_content === 'string'
            ? { reasoningContent: record.reasoning_content }
            : {}),
          ...(Array.isArray(record.tool_calls) ? { toolCalls: record.tool_calls } : {}),
          ...(typeof record.tool_call_id === 'string' ? { toolCallId: record.tool_call_id } : {}),
          ...(typeof timestamp === 'string' ? { timestamp } : {}),
          ...(typeof record.model === 'string' ? { model: record.model } : {}),
        },
      }),
    );
  }
  return { lines: out, unmapped };
}

export interface CostLabel {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  usd: number | null;
  usdSource: 'recorded' | 'export-table' | null;
}

/** Prices a cost the run left unpriced from the shipped table; an unknown model stays null. */
export function priceCost<T extends CostLabel>(cost: T, model: string | null): T {
  if (cost.usd !== null || !model || cost.inputTokens === null || cost.outputTokens === null)
    return cost;
  const name = model.replace(/^litellm\//, '').replace(/:[a-z]+$/, '');
  const claude = CLAUDE_PRICING[name];
  const cacheRead = cost.cacheReadTokens ?? 0;
  if (claude) {
    const usd =
      (cost.inputTokens * claude.input +
        cost.outputTokens * claude.output +
        cacheRead * (claude.cache_read ?? 0)) /
      1_000_000;
    return { ...cost, usd, usdSource: 'export-table' };
  }
  const openai = OPENAI_PRICING[name];
  if (openai)
    return {
      ...cost,
      usd: openaiCostUsd(openai, {
        input: cost.inputTokens,
        cachedInput: cacheRead,
        output: cost.outputTokens,
      }),
      usdSource: 'export-table',
    };
  return cost;
}
