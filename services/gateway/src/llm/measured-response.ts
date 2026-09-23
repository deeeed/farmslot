import { createHash } from 'node:crypto';

export interface MeasuredResponseOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  instructions: string;
  prompt: string;
  maxOutputTokens: number;
  reasoning: 'low' | 'medium';
  outputSchema?: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
}
export interface MeasuredResponse {
  status: 'completed' | 'incomplete' | 'unavailable';
  attempted: boolean;
  requestedModel: string;
  returnedModel?: string;
  responseId?: string;
  text?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** Raw Responses input_tokens includes cache reads/writes. */
  inputAccounting: 'includes-cache';
  durationMs: number;
  /** `fetch` resolved with an HTTP response, even if its body cannot be parsed. */
  responseReceived: boolean;
  receiptHash?: string;
  error?: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const counter = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** One bounded Responses request. No SDK retries, CLI fallback, or tool execution. */
export async function measuredResponsesCall(
  options: MeasuredResponseOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<MeasuredResponse> {
  if (
    !options.apiKey ||
    !/^[\w.-]{1,100}$/.test(options.model) ||
    !Number.isSafeInteger(options.maxOutputTokens) ||
    options.maxOutputTokens < 16 ||
    options.maxOutputTokens > 2048
  )
    throw new Error('Invalid measured model configuration');
  const url = new URL(options.baseUrl.replace(/\/$/, '') + '/responses');
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
  )
    throw new Error('Invalid measured provider URL');
  const body = JSON.stringify({
    model: options.model,
    instructions: options.instructions,
    input: [{ role: 'user', content: [{ type: 'input_text', text: options.prompt }] }],
    reasoning: { effort: options.reasoning },
    max_output_tokens: options.maxOutputTokens,
    store: false,
    stream: true,
    tools: [],
    service_tier: 'default',
    ...(options.outputSchema
      ? {
          text: {
            format: {
              type: 'json_schema',
              name: options.outputSchema.name,
              strict: true,
              schema: options.outputSchema.schema,
            },
          },
        }
      : {}),
  });

  const start = performance.now();
  const base: MeasuredResponse = {
    status: 'unavailable',
    attempted: false,
    requestedModel: options.model,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputAccounting: 'includes-cache',
    durationMs: 0,
    responseReceived: false,
  };
  const safeId = (value: unknown) =>
    typeof value === 'string' && /^[\w.-]{1,200}$/.test(value) && !value.includes(options.apiKey)
      ? value
      : undefined;
  const captureMetadata = (value: Record<string, unknown>): void => {
    base.returnedModel = safeId(value.model);
    base.responseId = safeId(value.id);
    const usage = object(value.usage) ? value.usage : undefined;
    const details = object(usage?.input_tokens_details) ? usage.input_tokens_details : undefined;
    base.inputTokens = counter(usage?.input_tokens);
    base.outputTokens = counter(usage?.output_tokens);
    base.cacheReadTokens = counter(details?.cached_tokens);
    base.cacheWriteTokens = counter(details?.cache_write_tokens);
  };
  if (Buffer.byteLength(body) > 64000) return { ...base, error: 'request-byte-limit' };
  const signal = AbortSignal.any([
    AbortSignal.timeout(60000),
    ...(options.signal ? [options.signal] : []),
  ]);
  if (signal.aborted) return { ...base, error: 'cancelled-before-transport' };
  try {
    base.attempted = true;
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
      body,
    });
    // This is deliberately set before reading the body. A malformed first SSE frame still
    // means the provider responded and must not be classified as a retryable transport failure.
    base.responseReceived = true;
    const reader = response.body?.getReader();
    if (!reader)
      return { ...base, error: 'missing-response-body', durationMs: performance.now() - start };
    const chunks: Uint8Array[] = [];
    let size = 0;
    const streaming =
      response.ok && response.headers.get('content-type')?.includes('text/event-stream');
    const decoder = streaming ? new TextDecoder('utf-8', { fatal: true }) : undefined;
    let pending = '';
    let final: unknown;
    const consumeEvent = (event: string): void => {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') return;
      const value: unknown = JSON.parse(data);
      if (
        object(value) &&
        ['response.completed', 'response.incomplete', 'response.failed'].includes(
          String(value.type),
        )
      ) {
        if (final !== undefined) throw new Error('Multiple terminal responses');
        final = value.response;
        if (object(final)) captureMetadata(final);
      }
    };
    const consumeCompleteEvents = (): void => {
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        consumeEvent(pending.slice(0, match.index));
        pending = pending.slice(match.index + match[0].length);
      }
    };
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        return { ...base, error: 'response-byte-limit', durationMs: performance.now() - start };
      }
      chunks.push(chunk.value);
      if (decoder) {
        pending += decoder.decode(chunk.value, { stream: true });
        consumeCompleteEvents();
      }
    }
    const bytes = Buffer.concat(chunks);
    const receiptHash = createHash('sha256').update(bytes).digest('hex');
    base.receiptHash = receiptHash;
    if (!response.ok)
      return { ...base, error: 'provider-http-error', durationMs: performance.now() - start };
    if (decoder) {
      pending += decoder.decode();
      consumeCompleteEvents();
      if (pending.trim()) consumeEvent(pending);
    } else final = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(final)) throw new Error('Missing terminal response');
    captureMetadata(final);
    if (base.returnedModel !== options.model)
      return { ...base, error: 'returned-model-mismatch', durationMs: performance.now() - start };
    if (base.outputTokens !== null && base.outputTokens > options.maxOutputTokens)
      return {
        ...base,
        error: 'output-token-bound-exceeded',
        durationMs: performance.now() - start,
      };
    if (final.status !== 'completed' && final.status !== 'incomplete')
      return { ...base, error: 'provider-terminal-failure', durationMs: performance.now() - start };
    if (!Array.isArray(final.output)) throw new Error('Missing response output');
    const parts: string[] = [];
    for (const item of final.output) {
      if (!object(item)) throw new Error('Invalid output item');
      if (item.type === 'reasoning') continue;
      if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content))
        throw new Error('Unexpected response action');
      for (const part of item.content) {
        if (!object(part) || part.type !== 'output_text' || typeof part.text !== 'string')
          throw new Error('Invalid response content');
        parts.push(part.text);
      }
    }
    const text = parts.join('');
    if (Buffer.byteLength(text) > 16000 || text.includes(options.apiKey))
      throw new Error('Rejected response text');
    return { ...base, status: final.status, text, durationMs: performance.now() - start };
  } catch {
    // Persist only controlled errors; upstream exceptions can contain credentials or input.
    return {
      ...base,
      error: signal.aborted ? 'request-timed-out-or-cancelled' : 'response-unavailable',
      durationMs: performance.now() - start,
    };
  }
}
