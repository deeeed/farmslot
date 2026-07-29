// llm/index.ts — Multi-provider LLM wrapper (ADR-014)
// Uses pi-ai for provider-agnostic calls with auth cascade.
// Falls back to claude CLI when no API key is available.

import type {
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEvent,
  Message as PiMessage,
  Tool,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai';

import type { ChatToolTraceEntry, StepLLMUsage } from '@farmslot/protocol';

import { execLocal } from '../core/exec.js';

import { resolveAuth } from './auth-resolve.js';
import { getLLMConfig } from './config.js';

// Token threshold at which we log a warning to nudge the user to start a new session.
// Sonnet 4.6 has a 1M token context window; haiku has 200k. At 80k input tokens we're
// still only at 8% of haiku's window, so this is a loose early-warning, not a hard limit.
const CHAT_TOKEN_WARN_THRESHOLD = 80_000;

export interface LLMCallOptions {
  provider?: string; // default: "anthropic"
  model?: string; // default: "haiku"
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Default true for interactive callers. Set false for authority-bound autonomous paths. */
  allowCliFallback?: boolean;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMChatOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  messages: ConversationMessage[]; // always required (CLI fallback path)
  piMessages?: PiMessage[]; // pre-built pi-ai history; bypasses stub construction
  maxTokens?: number;
  onDelta?: (text: string) => void;
  onStatus?: (text: string) => void;
  signal?: AbortSignal;
  tools?: Tool[];
  maxToolRounds?: number;
  toolExecutor?: (
    name: string,
    args: Record<string, unknown>,
    callId: string,
  ) => Promise<{ toolCallId: string; toolName: string; content: string; isError: boolean }>;
}

export interface LLMCallResult {
  text: string;
  usage: StepLLMUsage;
  piMessages?: PiMessage[]; // full message array used (input + new assistant msg)
  toolTrace?: ChatToolTraceEntry[];
  /** Provider stopReason — surfaces 'length' (max-tokens cap hit) so callers can distinguish truncation from format failures. */
  stopReason?: string;
}

// ─── Model ID mapping (friendly → pi-ai model ID) ───
// These must match the model IDs registered in pi-ai's built-in providers.
// Use `getModels(provider)` from pi-ai to discover available IDs.

const MODEL_ALIASES: Record<string, Record<string, string>> = {
  anthropic: {
    haiku: 'claude-haiku-4-5',
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-7',
    // Legacy names for backward compat
    'claude-3-haiku': 'claude-3-haiku-20240307',
    'claude-3-5-sonnet': 'claude-3-5-sonnet-20241022',
    'claude-3-opus': 'claude-3-opus-20240229',
  },
  openai: {
    'gpt-4o-mini': 'gpt-4o-mini',
    'gpt-4o': 'gpt-4o',
    'gpt-4.1-mini': 'gpt-4.1-mini',
    'gpt-4.1': 'gpt-4.1',
    'o3-mini': 'o3-mini',
  },
  google: {
    'gemini-flash': 'gemini-2.0-flash',
    'gemini-pro': 'gemini-2.0-pro',
  },
  'openai-codex': {
    // GPT-5.6 family uses tiered Codex slugs. Bare gpt-5.6 routes to Sol.
    'gpt-5.6': 'gpt-5.6-sol',
    'gpt-5.6-sol': 'gpt-5.6-sol',
    'gpt-5.6-terra': 'gpt-5.6-terra',
    'gpt-5.6-luna': 'gpt-5.6-luna',
    // pi-ai 0.74.x exposes gpt-5.5 natively for openai-codex — no longer need
    // to alias 5.5 down to 5.4. Keep 5.5-mini → 5.4-mini until codex ships a
    // 5.5-mini variant.
    'gpt-5.5-mini': 'gpt-5.4-mini',
    'gpt-5.5': 'gpt-5.5',
    'gpt-5.4-mini': 'gpt-5.4-mini',
    'gpt-5.4': 'gpt-5.4',
    'gpt-5.3-codex': 'gpt-5.3-codex',
    'gpt-5.3-codex-spark': 'gpt-5.3-codex-spark',
    'gpt-5.2': 'gpt-5.2',
    'gpt-5.1': 'gpt-5.1',
  },
};

// ─── Tier mapping (cross-provider) ───
// Tiers resolve to provider-specific alias names, then through MODEL_ALIASES.
// This lets callers use `model: 'fast'` regardless of provider.
export const TIER_MAP: Record<string, Record<string, string>> = {
  fast: {
    anthropic: 'haiku',
    openai: 'gpt-4.1-mini',
    'openai-codex': 'gpt-5.6-luna',
    google: 'gemini-flash',
  },
  standard: {
    anthropic: 'sonnet',
    openai: 'gpt-4.1',
    'openai-codex': 'gpt-5.6-terra',
    google: 'gemini-pro',
  },
  smart: {
    anthropic: 'opus',
    openai: 'gpt-4.1',
    'openai-codex': 'gpt-5.6-sol',
    google: 'gemini-pro',
  },
};

export function resolveTier(provider: string, model: string): string {
  const tierEntry = TIER_MAP[model];
  if (!tierEntry) return model; // not a tier name, pass through
  return tierEntry[provider] ?? model; // resolve to provider-specific alias
}

export function resolveModelId(provider: string, model: string): string {
  return MODEL_ALIASES[provider]?.[model] ?? model;
}

/**
 * Friendly identity string for the resolved model — useful for system
 * prompts so the chat agent can self-report (which the gateway can also
 * print to logs to verify it matches what's actually being called).
 *
 * Example: openai-codex/gpt-5.5 (requested tier: standard)
 */
export function describeModel(provider: string, model: string): string {
  const tierName = TIER_MAP[model] ? model : null;
  const resolvedId = resolveModelId(provider, resolveTier(provider, model));
  return tierName
    ? `${provider}/${resolvedId} (requested tier: ${tierName})`
    : `${provider}/${resolvedId}`;
}

// ─── Main callLLM ───

export async function callLLM(opts: LLMCallOptions): Promise<LLMCallResult> {
  const cfg = getLLMConfig();
  const provider = opts.provider ?? cfg.defaultProvider;
  const model = opts.model ?? cfg.intelligenceModel;
  const maxTokens = opts.maxTokens ?? 1024;

  const resolvedModel = resolveTier(provider, model);

  const auth = await resolveAuth(provider);

  if (auth) {
    return callViaPiAi(provider, resolvedModel, auth.apiKey, auth.source, opts, maxTokens);
  }

  if (opts.allowCliFallback === false) {
    throw new Error(`[llm] no API auth for ${provider}; CLI fallback disabled for this caller`);
  }

  // CLI fallback (Claude-only)
  console.log(`[llm] no auth for ${provider}, falling back to CLI`);
  return callViaCli(resolvedModel, opts);
}

// ─── pi-ai path ───

async function callViaPiAi(
  provider: string,
  model: string,
  apiKey: string,
  source: string,
  opts: LLMCallOptions,
  maxTokens: number,
): Promise<LLMCallResult> {
  const start = Date.now();
  const modelId = resolveModelId(provider, model);

  // Dynamic import to avoid load-time failure if pi-ai has issues
  const piAi = await import('@earendil-works/pi-ai');

  // getModel is strictly typed to KnownProvider — cast since we also support custom providers
  const piModel = (piAi.getModel as (p: string, m: string) => ReturnType<typeof piAi.getModel>)(
    provider,
    modelId,
  );
  if (!piModel) {
    throw new Error(
      `[llm] unknown model: ${provider}/${modelId} — check MODEL_ALIASES or use a full pi-ai model ID`,
    );
  }

  // pi-ai Context supports systemPrompt directly + Message[] with timestamp
  // openai-codex requires instructions (systemPrompt) — always provide one.
  const now = Date.now();
  let httpStatus: number | undefined;
  let httpHeaders: Record<string, string> | undefined;
  const response = await piAi.completeSimple(
    piModel,
    {
      systemPrompt: opts.systemPrompt || 'You are a helpful assistant. Be concise.',
      messages: [{ role: 'user' as const, content: opts.userPrompt, timestamp: now }],
    },
    {
      apiKey,
      maxTokens,
      signal: opts.signal,
      onResponse: ({ status, headers }: { status: number; headers: Record<string, string> }) => {
        httpStatus = status;
        httpHeaders = headers;
      },
    } as Parameters<typeof piAi.completeSimple>[2],
  );

  // Extract text — content is string | ContentBlock[]
  const text =
    typeof response.content === 'string'
      ? response.content
      : ((response.content as Array<{ type: string; text?: string }>)
          ?.filter((b: { type: string }) => b.type === 'text')
          .map((b: { text?: string }) => b.text ?? '')
          .join('') ?? '');

  const durationMs = Date.now() - start;
  // pi-ai Usage has input/output (not inputTokens/outputTokens)
  const usage: StepLLMUsage = {
    provider,
    model,
    inputTokens: response.usage?.input,
    outputTokens: response.usage?.output,
    costUsd: response.usage?.cost?.total,
    durationMs,
  };

  console.log(
    `[llm] ${provider}/${model} via ${source} — ${usage.inputTokens ?? '?'}in/${usage.outputTokens ?? '?'}out ${durationMs}ms`,
  );

  // pi-ai surfaces transport errors via `stopReason` instead of throwing —
  // an expired auth token, a 5xx upstream, or an aborted stream all return a
  // valid AssistantMessage with empty content and stopReason 'error'/'aborted'.
  // Treat those as failures so callers don't silently get an empty response.
  const stopReason = (response as { stopReason?: string }).stopReason;
  if (stopReason === 'error' || stopReason === 'aborted') {
    throw new Error(
      formatProviderError(provider, model, source, stopReason, httpStatus, httpHeaders),
    );
  }

  // Surface stopReason on the success path too — callers building structured
  // outputs (e.g. pr-body-recipe) need to distinguish a clean 'stop' finish
  // from a 'length' truncation.
  return { text, usage, stopReason };
}

// Headers shouldn't normally exceed a few KB; cap the base64 decode + JSON
// parse window so a misbehaving proxy that returns a megabyte of opaque data
// can't make the error formatter chew through it.
const MAX_ERROR_HEADER_DECODE_BYTES = 8 * 1024;

function formatProviderError(
  provider: string,
  model: string,
  source: string,
  stopReason: string,
  status: number | undefined,
  headers: Record<string, string> | undefined,
): string {
  const parts = [`[llm] ${provider}/${model} via ${source} stopped with reason=${stopReason}`];
  if (status !== undefined) parts.push(`http=${status}`);
  // Provider-specific error headers worth surfacing in the message.
  const hints: string[] = [];
  if (headers) {
    for (const key of [
      'x-openai-ide-error-code',
      'x-openai-authorization-error',
      'x-error-code',
      'x-request-id',
    ]) {
      const val = headers[key] ?? headers[key.toLowerCase()];
      if (val) hints.push(`${key}=${val}`);
    }
    // Some providers base64-encode the error JSON in x-error-json.
    const errJson = headers['x-error-json'] ?? headers['x-error-json'.toLowerCase()];
    if (errJson) {
      if (errJson.length > MAX_ERROR_HEADER_DECODE_BYTES) {
        hints.push(`x-error-json=<oversize:${errJson.length}b>`);
      } else {
        try {
          const decoded = Buffer.from(errJson, 'base64').toString('utf-8');
          const parsed = JSON.parse(decoded);
          const msg = parsed?.error?.message;
          if (msg) hints.push(`message=${JSON.stringify(msg)}`);
        } catch {
          /* header not base64 JSON — skip */
        }
      }
    }
  }
  if (hints.length > 0) parts.push(hints.join(' '));
  return parts.join(' ');
}

// ─── callLLMChat — multi-turn conversation ───

export async function callLLMChat(opts: LLMChatOptions): Promise<LLMCallResult> {
  const cfg = getLLMConfig();
  const provider = opts.provider ?? cfg.defaultProvider;
  const model = opts.model ?? cfg.copilotModel;
  const maxTokens = opts.maxTokens ?? 2048;
  const resolvedModel = resolveTier(provider, model);

  const auth = await resolveAuth(provider);

  if (auth) {
    return callChatViaPiAi(provider, resolvedModel, auth.apiKey, auth.source, opts, maxTokens);
  }

  // CLI fallback: flatten conversation to single prompt
  console.log(`[llm] no auth for ${provider}, falling back to CLI for chat`);
  const flatPrompt = opts.messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
  return callViaCli(resolvedModel, { ...opts, userPrompt: flatPrompt });
}

async function callChatViaPiAi(
  provider: string,
  model: string,
  apiKey: string,
  source: string,
  opts: LLMChatOptions,
  maxTokens: number,
): Promise<LLMCallResult> {
  const start = Date.now();
  const modelId = resolveModelId(provider, model);

  const piAi = await import('@earendil-works/pi-ai');

  const piModel = (piAi.getModel as (p: string, m: string) => ReturnType<typeof piAi.getModel>)(
    provider,
    modelId,
  );
  if (!piModel) {
    throw new Error(`[llm] unknown model: ${provider}/${modelId}`);
  }

  const zeroUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const now = Date.now();

  // Build the pi-ai messages array.
  // If caller provides pre-built piMessages (stateful session path), use them directly.
  // Otherwise build stubs from ConversationMessage[] (first-call or CLI-fallback reconstruction).
  let piMessages: PiMessage[];
  if (opts.piMessages && opts.piMessages.length > 0) {
    piMessages = opts.piMessages;
  } else {
    piMessages = opts.messages.map((m): PiMessage => {
      if (m.role === 'user') {
        return { role: 'user' as const, content: m.content, timestamp: now };
      }
      return {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: m.content }],
        api: piModel.api,
        provider: piModel.provider,
        model: modelId,
        usage: zeroUsage,
        stopReason: 'stop' as const,
        timestamp: now,
      };
    });
  }

  let text = '';
  let realAssistantMsg: PiAssistantMessage | undefined;

  const maxToolRounds = Math.max(1, opts.maxToolRounds ?? 15);
  const hasTools = opts.tools && opts.tools.length > 0;
  let toolRoundsUsed = 0;
  const toolTrace: ChatToolTraceEntry[] = [];

  outer: for (let round = 0; round < maxToolRounds; round++) {
    const context = {
      systemPrompt: opts.systemPrompt,
      messages: piMessages,
      ...(hasTools ? { tools: opts.tools } : {}),
    };

    if (opts.onDelta) {
      // Streaming path — capture real AssistantMessage from the done event
      const stream = piAi.streamSimple(piModel, context, {
        apiKey,
        maxTokens,
        signal: opts.signal,
      });
      let roundText = '';
      for await (const event of stream as AsyncIterable<AssistantMessageEvent>) {
        if (event.type === 'text_delta') {
          roundText += event.delta;
          opts.onDelta(event.delta);
        }
        if (event.type === 'done') {
          realAssistantMsg = event.message;
          if (event.reason !== 'toolUse') {
            const fallbackDelta = fallbackDoneTextDelta(
              roundText,
              extractText(realAssistantMsg),
              event.reason,
            );
            if (fallbackDelta) {
              roundText += fallbackDelta;
              opts.onDelta(fallbackDelta);
            }
            text = roundText;
            piMessages = [...piMessages, realAssistantMsg as PiMessage];
            break outer;
          }
          // Tool round: execute tool calls, append results, continue loop
          toolRoundsUsed = round + 1;
          opts.onStatus?.(formatToolRoundStatus(realAssistantMsg, toolRoundsUsed));
          const { results, trace } = await buildToolResults(
            realAssistantMsg,
            opts.toolExecutor,
            toolRoundsUsed,
          );
          toolTrace.push(...trace);
          console.log(
            `[llm] tool round ${toolRoundsUsed}/${maxToolRounds}: ${results.length} tool call(s)`,
          );
          piMessages = [...piMessages, realAssistantMsg as PiMessage, ...results];
          break; // next round
        }
      }
    } else {
      // Non-streaming path
      const response = await piAi.completeSimple(piModel, context, {
        apiKey,
        maxTokens,
        signal: opts.signal,
      });
      realAssistantMsg = response;
      const toolCalls = (response.content as Array<{ type: string }>).filter(
        (b) => b.type === 'toolCall',
      );
      if (!toolCalls.length) {
        text = extractText(response);
        piMessages = [...piMessages, response as PiMessage];
        break outer;
      }
      toolRoundsUsed = round + 1;
      opts.onStatus?.(formatToolRoundStatus(response, toolRoundsUsed));
      const { results, trace } = await buildToolResults(
        response,
        opts.toolExecutor,
        toolRoundsUsed,
      );
      toolTrace.push(...trace);
      console.log(
        `[llm] tool round ${toolRoundsUsed}/${maxToolRounds}: ${results.length} tool call(s)`,
      );
      piMessages = [...piMessages, response as PiMessage, ...results];
    }
  }

  // Use the real AssistantMessage from the LLM response; fall back to stub only if missing
  const newAssistantMsg: PiAssistantMessage =
    realAssistantMsg ??
    ({
      role: 'assistant',
      content: [{ type: 'text' as const, text }],
      api: piModel.api,
      provider: piModel.provider,
      model: modelId,
      usage: zeroUsage,
      stopReason: 'stop',
      timestamp: Date.now(),
    } as PiAssistantMessage);

  if (toolRoundsUsed >= maxToolRounds) {
    console.warn(`[llm] chat hit tool round cap (${maxToolRounds}) — response may be incomplete`);
  }

  // If we ended mid-tool-loop, extract whatever text the last message had
  if (!text && realAssistantMsg) {
    text = extractText(realAssistantMsg);
  }

  const outPiMessages = piMessages.includes(newAssistantMsg as PiMessage)
    ? piMessages
    : [...piMessages, newAssistantMsg as PiMessage];

  const durationMs = Date.now() - start;
  const ru = newAssistantMsg.usage;
  const usage: StepLLMUsage = {
    provider,
    model,
    inputTokens: ru?.input || undefined,
    outputTokens: ru?.output || undefined,
    costUsd: ru?.cost?.total || undefined,
    durationMs,
  };

  const tokenSummary = usage.inputTokens
    ? `${usage.inputTokens}in/${usage.outputTokens ?? '?'}out`
    : `${text.length}chars`;
  console.log(
    `[llm] chat ${provider}/${model} via ${source} — ${tokenSummary} ${durationMs}ms${usage.costUsd ? ` $${usage.costUsd.toFixed(4)}` : ''}`,
  );
  if (usage.inputTokens && usage.inputTokens > CHAT_TOKEN_WARN_THRESHOLD) {
    console.warn(
      `[llm] chat session large: ${usage.inputTokens} input tokens — consider starting a new session (/new)`,
    );
  }

  return { text, usage, piMessages: outPiMessages, ...(toolTrace.length > 0 ? { toolTrace } : {}) };
}

function extractText(msg: PiAssistantMessage): string {
  return typeof msg.content === 'string'
    ? msg.content
    : ((msg.content as Array<{ type: string; text?: string }>)
        ?.filter((b: { type: string }) => b.type === 'text')
        .map((b: { text?: string }) => b.text ?? '')
        .join('') ?? '');
}

export function fallbackDoneTextDelta(
  roundText: string,
  doneText: string,
  reason?: string,
): string | null {
  if (reason === 'toolUse') return null;
  if (roundText || !doneText) return null;
  return doneText;
}

function formatToolRoundStatus(assistantMsg: PiAssistantMessage, round: number): string {
  const count = Array.isArray(assistantMsg.content)
    ? assistantMsg.content.filter((block) => block.type === 'toolCall').length
    : 0;
  const label = count === 1 ? 'tool' : 'tools';
  return `Checking context with ${count || 'gateway'} ${label}…${round > 1 ? ` round ${round}` : ''}`;
}

type ToolExecutorFn = (
  name: string,
  args: Record<string, unknown>,
  callId: string,
) => Promise<{ toolCallId: string; toolName: string; content: string; isError: boolean }>;

interface ToolBuildResult {
  results: ToolResultMessage[];
  trace: ChatToolTraceEntry[];
}

export async function buildToolResults(
  assistantMsg: PiAssistantMessage,
  customExecutor?: ToolExecutorFn,
  round = 1,
): Promise<ToolBuildResult> {
  const executor = customExecutor ?? (await import('../chat/chat-tools.js')).executeTool;
  const toolCalls = (assistantMsg.content as Array<ToolCall>).filter((b) => b.type === 'toolCall');
  const results: ToolResultMessage[] = [];
  const trace: ChatToolTraceEntry[] = [];
  for (const tc of toolCalls) {
    console.log(`[llm] tool call: ${tc.name} args=${summarizeToolArgs(tc.arguments) ?? 'none'}`);
    const startedAt = new Date();
    const startedMs = Date.now();
    const r = await executor(tc.name, tc.arguments, tc.id);
    const completedAt = new Date();
    results.push({
      role: 'toolResult' as const,
      toolCallId: r.toolCallId,
      toolName: r.toolName,
      content: [{ type: 'text' as const, text: r.content }],
      isError: r.isError,
      timestamp: Date.now(),
    });
    trace.push(
      summarizeToolTraceEntry({
        callId: r.toolCallId,
        toolName: r.toolName,
        round,
        args: tc.arguments,
        content: r.content,
        isError: r.isError,
        startedAt,
        completedAt,
        durationMs: Date.now() - startedMs,
      }),
    );
  }
  return { results, trace };
}

const TRACE_SUMMARY_LIMIT = 700;
const TRACE_SECRET_KEY_RE =
  /(token|secret|password|authorization|apikey|api_key|privatekey|private_key|cookie|session)/i;
const FILE_LIKE_TOOLS = new Set(['read_farmslot_file', 'read_task_file', 'read_file']);
const LOG_LIKE_TOOLS = new Set(['terminal_snapshot', 'list_farmslot_logs']);

interface ToolTraceInput {
  callId: string;
  toolName: string;
  round: number;
  args: Record<string, unknown>;
  content: string;
  isError: boolean;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
}

export function summarizeToolTraceEntry(input: ToolTraceInput): ChatToolTraceEntry {
  const outputSize = input.content.length;
  const argsSummary = summarizeToolArgs(input.args);
  const summary = summarizeToolResult(input.toolName, input.content, input.isError);
  return {
    callId: input.callId,
    toolName: input.toolName,
    round: input.round,
    status: input.isError ? 'error' : 'ok',
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    durationMs: input.durationMs,
    ...(argsSummary ? { argsSummary } : {}),
    resultSummary: summary.text,
    outputSize,
    truncated: summary.truncated || outputSize > summary.text.length,
    summaryKind: summary.kind,
  };
}

function summarizeToolArgs(args: Record<string, unknown>): string | undefined {
  const keys = Object.keys(args ?? {}).sort();
  if (keys.length === 0) return undefined;
  const parts = [`keys=${keys.join(',')}`];
  for (const key of keys) {
    if (TRACE_SECRET_KEY_RE.test(key)) {
      parts.push(`${key}=<redacted>`);
      continue;
    }
    if (!isSafeIdentifierKey(key)) continue;
    const value = args[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}=${sanitizeTraceText(String(value), 80).text}`);
    }
  }
  return sanitizeTraceText(parts.join(' '), TRACE_SUMMARY_LIMIT).text;
}

function summarizeToolResult(
  toolName: string,
  content: string,
  isError: boolean,
): { text: string; truncated: boolean; kind: ChatToolTraceEntry['summaryKind'] } {
  if (isError) {
    const safe = sanitizeTraceText(content, TRACE_SUMMARY_LIMIT);
    return { text: safe.text, truncated: safe.truncated, kind: 'error' };
  }

  const parsed = tryParseJson(content);
  if (parsed.ok) {
    return summarizeJsonToolResult(toolName, parsed.value, content.length);
  }

  const safe = sanitizeTraceText(
    `${content.split(/\r?\n/).length} line(s), ${content.length} chars`,
    TRACE_SUMMARY_LIMIT,
  );
  return {
    text: safe.text,
    truncated: safe.truncated,
    kind: LOG_LIKE_TOOLS.has(toolName) ? 'log-read' : 'text',
  };
}

function summarizeJsonToolResult(
  toolName: string,
  value: unknown,
  outputSize: number,
): { text: string; truncated: boolean; kind: ChatToolTraceEntry['summaryKind'] } {
  if (FILE_LIKE_TOOLS.has(toolName)) {
    const obj = isRecord(value) ? value : {};
    const content = typeof obj.content === 'string' ? obj.content : '';
    const text = [
      `path=${safeScalar(obj.path) ?? 'unknown'}`,
      `contentChars=${content.length}`,
      `truncated=${String(Boolean(obj.truncated))}`,
      `keys=${Object.keys(obj).sort().join(',')}`,
    ].join(' ');
    const safe = sanitizeTraceText(text, TRACE_SUMMARY_LIMIT);
    return { text: safe.text, truncated: safe.truncated || content.length > 0, kind: 'file-read' };
  }

  if (toolName === 'run_context_bundle') {
    const obj = isRecord(value) ? value : {};
    const run = isRecord(obj.run) ? obj.run : {};
    const text = [
      `run=${safeScalar(run.id) ?? 'unknown'}`,
      `status=${safeScalar(run.status) ?? 'unknown'}`,
      `steps=${Array.isArray(obj.currentSteps) ? obj.currentSteps.length : 0}`,
      `decisions=${Array.isArray(obj.pendingDecisions) ? obj.pendingDecisions.length : 0}`,
      `taskFiles=${Array.isArray(obj.taskFiles) ? obj.taskFiles.length : 0}`,
      `artifacts=${Array.isArray(obj.artifacts) ? obj.artifacts.length : 0}`,
      `outputChars=${outputSize}`,
    ].join(' ');
    const safe = sanitizeTraceText(text, TRACE_SUMMARY_LIMIT);
    return { text: safe.text, truncated: safe.truncated, kind: 'run-bundle' };
  }

  if (toolName === 'investigate_gateway_issue') {
    const obj = isRecord(value) ? value : {};
    const report = typeof obj.report === 'string' ? obj.report : '';
    const worker = isRecord(obj.worker) ? obj.worker : {};
    const text = [
      `worker=${safeScalar(worker.kind) ?? 'unknown'}`,
      `runtime=${safeScalar(worker.runtime) ?? 'unknown'}`,
      `reportChars=${report.length}`,
      `outputChars=${outputSize}`,
    ].join(' ');
    const safe = sanitizeTraceText(text, TRACE_SUMMARY_LIMIT);
    return {
      text: safe.text,
      truncated: safe.truncated || report.length > 0,
      kind: 'investigation-report',
    };
  }

  if (LOG_LIKE_TOOLS.has(toolName)) {
    const text = summarizeJsonShape(value);
    const safe = sanitizeTraceText(text, TRACE_SUMMARY_LIMIT);
    return { text: safe.text, truncated: safe.truncated, kind: 'log-read' };
  }

  const safe = sanitizeTraceText(summarizeJsonShape(value), TRACE_SUMMARY_LIMIT);
  return { text: safe.text, truncated: safe.truncated, kind: 'json-shape' };
}

function summarizeJsonShape(value: unknown): string {
  if (Array.isArray(value)) return `array length=${value.length}`;
  if (!isRecord(value)) return `${typeof value}`;
  const keys = Object.keys(value).sort();
  const parts = [`keys=${keys.join(',')}`];
  for (const key of keys) {
    if (TRACE_SECRET_KEY_RE.test(key)) {
      parts.push(`${key}=<redacted>`);
      continue;
    }
    const item = value[key];
    if (Array.isArray(item)) parts.push(`${key}.length=${item.length}`);
    else if (isRecord(item)) parts.push(`${key}.keys=${Object.keys(item).sort().join(',')}`);
    else if (isSafeIdentifierKey(key)) {
      const scalar = safeScalar(item);
      if (scalar) parts.push(`${key}=${scalar}`);
    }
  }
  return parts.join(' ');
}

function sanitizeTraceText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const redacted = text
    .replace(/SENTINEL_SECRET_DO_NOT_PERSIST/g, '<redacted>')
    .replace(/SENTINEL_FILE_SNIPPET_DO_NOT_PERSIST/g, '<redacted>')
    .replace(
      /(token|secret|password|authorization|api[_-]?key|private[_-]?key|cookie|session)(["'\s:=]+)[^"',\s}]+/gi,
      '$1$2<redacted>',
    );
  if (redacted.length <= maxChars) return { text: redacted, truncated: false };
  return { text: `${redacted.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true };
}

function tryParseJson(content: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch (_err) {
    // Tool outputs may be plain text; callers use this signal to choose a text summary path.
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeScalar(value: unknown): string | undefined {
  if (typeof value === 'string') return sanitizeTraceText(value, 120).text;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function isSafeIdentifierKey(key: string): boolean {
  return /(^id$|Id$|_id$|run|slot|path|status|state|type|flow|ticket|route|hash|count|total|queued|active|pending|tool|model|provider|runtime|focus|question)/i.test(
    key,
  );
}

// ─── CLI fallback ───

async function callViaClaudeCli(model: string, opts: LLMCallOptions): Promise<LLMCallResult> {
  const start = Date.now();
  const input = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n---\n\n${opts.userPrompt}`
    : opts.userPrompt;
  const escaped = input.replace(/'/g, "'\\''");

  const safeModel = model.replace(/[^a-zA-Z0-9._-]/g, '');
  const result = await execLocal(
    `echo '${escaped}' | claude -p --model ${safeModel} --output-format json 2>/dev/null`,
    { timeout: 60000 },
  );

  if (result.exitCode !== 0) {
    throw new Error(`claude CLI failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`);
  }

  let text: string;
  try {
    const parsed = JSON.parse(result.stdout);
    text = parsed.result ?? result.stdout;
  } catch {
    text = result.stdout.trim();
  }

  const durationMs = Date.now() - start;
  return {
    text,
    usage: {
      provider: 'cli:claude',
      model,
      durationMs,
    },
  };
}

async function callViaCodexCli(model: string, opts: LLMCallOptions): Promise<LLMCallResult> {
  const start = Date.now();
  const input = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n---\n\n${opts.userPrompt}`
    : opts.userPrompt;
  const escaped = input.replace(/'/g, "'\\''");

  const safeModel = model.replace(/[^a-zA-Z0-9._-]/g, '');
  const result = await execLocal(`echo '${escaped}' | codex -q --model ${safeModel} 2>/dev/null`, {
    timeout: 120000,
  });

  if (result.exitCode !== 0) {
    throw new Error(`codex CLI failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`);
  }

  const text = result.stdout.trim();
  const durationMs = Date.now() - start;
  return {
    text,
    usage: {
      provider: 'cli:codex',
      model,
      durationMs,
    },
  };
}

async function callViaCli(model: string, opts: LLMCallOptions): Promise<LLMCallResult> {
  let claudeError: Error | undefined;
  try {
    return await callViaClaudeCli(model, opts);
  } catch (err) {
    claudeError = err as Error;
    console.log(`[llm] claude CLI failed: ${claudeError.message}, trying codex`);
  }

  try {
    const codexModel = resolveTier('openai', model);
    return await callViaCodexCli(codexModel, opts);
  } catch (codexErr) {
    throw new Error(
      `[llm] all CLI fallbacks failed:\n  claude: ${claudeError!.message}\n  codex: ${(codexErr as Error).message}`,
    );
  }
}
