// OpenAI-compatible Pi providers: optional discovery, validated model configuration.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_OLLAMA = '127.0.0.1:11434';

/** Bound worker HTTP requests through the final response byte. Pi owns retries. */
export function deadlinePiFetch(fetchImpl, timeoutMs = 5 * 60_000, onExhausted) {
  let consecutiveTimeouts = 0;
  const boundedFetch = async (input, options = {}) => {
    const upstream = options.signal ?? (input instanceof Request ? input.signal : undefined);
    const deadline = new AbortController();
    const signal = upstream ? AbortSignal.any([upstream, deadline.signal]) : deadline.signal;
    const timer = setTimeout(() => {
      if (upstream?.aborted) return;
      deadline.abort();
      if (++consecutiveTimeouts >= 2) onExhausted?.();
    }, timeoutMs);
    const failure = (error) =>
      deadline.signal.aborted && !upstream?.aborted
        ? new Error(`Pi model request timed out after ${timeoutMs}ms`)
        : error;
    try {
      const response = await fetchImpl(input, { ...options, signal });
      if (!response.body) {
        clearTimeout(timer);
        consecutiveTimeouts = 0;
        return response;
      }
      const reader = response.body.getReader();
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              clearTimeout(timer);
              consecutiveTimeouts = 0;
              controller.close();
            } else controller.enqueue(next.value);
          } catch (error) {
            clearTimeout(timer);
            controller.error(failure(error));
          }
        },
        cancel(reason) {
          clearTimeout(timer);
          deadline.abort(reason);
          return reader.cancel(reason);
        },
      });
      const bounded = new Response(body, response);
      Object.defineProperty(bounded, 'url', { value: response.url });
      return bounded;
    } catch (error) {
      clearTimeout(timer);
      throw failure(error);
    }
  };
  boundedFetch.reset = () => {
    consecutiveTimeouts = 0;
  };
  return boundedFetch;
}

export function openaiBaseUrl(raw) {
  let url = String(raw ?? '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, '');
  if (url.endsWith('/v1')) return url;
  return `${url}/v1`;
}

export function listPiProviderSources(env = process.env) {
  const sources = [];
  if (env.FARMSLOT_PI_OLLAMA !== '0') {
    const ollama =
      env.FARMSLOT_PI_OLLAMA_URL || env.OLLAMA_BASE_URL || env.OLLAMA_HOST || DEFAULT_OLLAMA;
    sources.push({
      id: 'ollama',
      name: 'Ollama',
      baseUrl: openaiBaseUrl(ollama),
      apiKey: env.OLLAMA_API_KEY || 'ollama',
    });
  }
  const litellmUrl = env.LITELLM_URL || env.LITELLM_BASE_URL;
  if (litellmUrl) {
    sources.push({
      id: 'litellm',
      name: 'LiteLLM',
      baseUrl: openaiBaseUrl(litellmUrl),
      apiKey: env.LITELLM_API_KEY || 'local',
    });
  }
  const routerUrl = env.FARMSLOT_PI_ROUTER_URL;
  if (routerUrl && openaiBaseUrl(routerUrl) !== openaiBaseUrl(litellmUrl || '')) {
    sources.push({
      id: 'router',
      name: 'OpenAI-compatible router',
      baseUrl: openaiBaseUrl(routerUrl),
      apiKey: env.FARMSLOT_PI_ROUTER_KEY || env.LITELLM_API_KEY || 'local',
    });
  }
  return sources.filter((source) => source.baseUrl);
}

export async function fetchOpenAiModels(
  baseUrl,
  apiKey,
  { fetchImpl = globalThis.fetch, timeoutMs = 400, endpoint = 'models', idField = 'id' } = {},
) {
  if (typeof fetchImpl !== 'function') return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(`${baseUrl}/${endpoint}`, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const body = await response.json();
    const rows = Array.isArray(body?.data) ? body.data : [];
    return rows.filter((row) => typeof row?.[idField] === 'string' && row[idField].trim());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export class PiProviderConfigurationError extends Error {}

function positiveInteger(value, name) {
  if (value === undefined || value === null) return undefined;
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) <= 0
  )
    throw new PiProviderConfigurationError(`${name} must be a positive safe integer`);
  return Number(value);
}

function reasoningSetting(value, name) {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw new PiProviderConfigurationError(`${name} must be true, false, 1 or 0`);
}

function configuredModelLimits(raw, name) {
  if (raw === undefined) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PiProviderConfigurationError(`${name} must be a JSON object keyed by model id`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new PiProviderConfigurationError(`${name} must be a JSON object keyed by model id`);
  return new Map(
    Object.entries(parsed).map(([id, settings]) => {
      if (
        !settings ||
        typeof settings !== 'object' ||
        Array.isArray(settings) ||
        Object.keys(settings).some(
          (key) => !['contextWindow', 'maxTokens', 'reasoning'].includes(key),
        )
      )
        throw new PiProviderConfigurationError(
          `${name}/${id} must contain contextWindow, maxTokens or reasoning`,
        );
      return [
        id,
        {
          contextWindow: positiveInteger(settings.contextWindow, `${name}/${id} contextWindow`),
          maxTokens: positiveInteger(settings.maxTokens, `${name}/${id} maxTokens`),
          reasoning: reasoningSetting(settings.reasoning, `${name}/${id} reasoning`),
        },
      ];
    }),
  );
}

function modelLimit(reported, cap, fallback, name) {
  const real = positiveInteger(reported, name);
  return cap === undefined ? (real ?? fallback) : Math.min(real ?? cap, cap);
}

function modelEntry(row, source, defaults, info = {}, configured = {}) {
  const context =
    row.context_length ??
    row.max_model_len ??
    row.context_window ??
    row.contextWindow ??
    info.max_input_tokens;
  const output =
    row.max_output_tokens ??
    row.max_completion_tokens ??
    row.max_tokens ??
    row.maxTokens ??
    info.max_output_tokens;
  const reasoning =
    reasoningSetting(
      row.reasoning ?? row.supports_reasoning ?? info.supports_reasoning,
      `${source}/${row.id} reasoning`,
    ) ??
    configured.reasoning ??
    defaults.reasoning;
  if ((source === 'router' || configured.reasoning === true) && !reasoning)
    throw new PiProviderConfigurationError(
      `Model ${source}/${row.id} requires reasoning for code work`,
    );
  return {
    id: row.id,
    name: row.id,
    reasoning,
    ...(source === 'router'
      ? {
          thinkingLevelMap: {
            minimal: 'minimal',
            low: 'low',
            medium: 'medium',
            high: 'high',
            xhigh: 'xhigh',
            max: 'max',
          },
        }
      : {}),
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelLimit(
      context,
      configured.contextWindow,
      defaults.contextWindow,
      `${source}/${row.id} context`,
    ),
    maxTokens: modelLimit(
      output,
      configured.maxTokens,
      defaults.maxTokens,
      `${source}/${row.id} maxTokens`,
    ),
  };
}

export async function resolvePiProviderCatalog(env = process.env, opts = {}) {
  const sources = listPiProviderSources(env);
  const resolved = await Promise.all(
    sources.map(async (source) => {
      const prefix = `FARMSLOT_PI_${source.id.toUpperCase()}`;
      const defaults = {
        contextWindow: positiveInteger(env[`${prefix}_CONTEXT`], `${prefix}_CONTEXT`) ?? 128000,
        maxTokens: positiveInteger(env[`${prefix}_MAX_TOKENS`], `${prefix}_MAX_TOKENS`) ?? 8192,
        reasoning:
          reasoningSetting(env[`${prefix}_REASONING`], `${prefix}_REASONING`) ??
          source.id === 'router',
      };
      const overrides = configuredModelLimits(
        env[`${prefix}_MODEL_LIMITS`],
        `${prefix}_MODEL_LIMITS`,
      );
      const fetchOptions = { timeoutMs: source.id === 'litellm' ? 5000 : 400, ...opts };
      const [rows, infos] = await Promise.all([
        fetchOpenAiModels(source.baseUrl, source.apiKey, fetchOptions),
        source.id === 'litellm'
          ? fetchOpenAiModels(source.baseUrl, source.apiKey, {
              ...fetchOptions,
              endpoint: 'model/info',
              idField: 'model_name',
            })
          : [],
      ]);
      if (rows.length === 0) return null;
      const infoById = new Map(infos.map((entry) => [entry.model_name, entry.model_info]));
      return {
        ...source,
        models: rows.map((row) =>
          modelEntry(row, source.id, defaults, infoById.get(row.id) ?? {}, overrides.get(row.id)),
        ),
      };
    }),
  );
  return resolved.filter(Boolean);
}

/** @typedef {{ provider: string, model: string, contextWindow: number, maxTokens: number, reasoning: boolean, effort: string, requestedMaxTokens?: number }} PiModelRequestConfiguration */

/**
 * Refuse a reasoning-enabled request that Pi downgraded to non-reasoning; record actual wire effort.
 * @param {(configuration: PiModelRequestConfiguration) => void} [onRequest]
 */
export function providerReasoningFetch(fetchImpl, providers = [], onRequest) {
  const byUrl = new Map(
    providers
      .filter((source) => ['router', 'litellm'].includes(source.id))
      .map((source) => [`${source.baseUrl}/chat/completions`, source]),
  );
  if (byUrl.size === 0) return fetchImpl;
  return async (input, options = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const provider = byUrl.get(url);
    if (provider) {
      const raw = options.body ?? (input instanceof Request ? await input.clone().text() : '');
      const payload = JSON.parse(raw);
      const model = provider.models.find((entry) => entry.id === payload.model);
      if (model && (provider.id === 'router' || model.reasoning)) {
        const effort = payload.reasoning_effort;
        if (
          !model.reasoning ||
          typeof effort !== 'string' ||
          !effort.trim() ||
          ['off', 'none'].includes(effort)
        )
          throw new PiProviderConfigurationError(
            `Model ${provider.id}/${model.id} requires a reasoning effort; refusing a non-reasoning request`,
          );
        onRequest?.({
          provider: provider.id,
          model: model.id,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          requestedMaxTokens: payload.max_completion_tokens ?? payload.max_tokens,
          reasoning: true,
          effort,
        });
      }
    }
    return fetchImpl(input, options);
  };
}

/** Native auth excludes extensions; their authenticated model discovery is the admission check. */
function nativePiAuth(binary, model, env) {
  const result = spawnSync(binary, ['auth', 'check', '--model', model, '--json'], {
    env,
    encoding: 'utf8',
    timeout: 25_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const value = JSON.parse(result.stdout);
    if (['ready', 'not_ready', 'invalid'].includes(value?.status))
      return {
        status:
          result.status === 0 ? value.status : value.status === 'ready' ? 'invalid' : value.status,
        reason: [
          'provider_not_found',
          'credentials_not_configured',
          'credential_not_available',
          'invalid_state',
        ].includes(value.reason)
          ? value.reason
          : undefined,
      };
  } catch {
    // An unsupported runner or failed process can exit before its structured verdict.
  }
  return unavailablePiAuth(result);
}

/** Why the native check gave no verdict. Its output is never passed on: it can carry credentials. */
export function unavailablePiAuth(result) {
  const cause =
    result.error?.code === 'ETIMEDOUT'
      ? 'timeout'
      : result.error?.code === 'ENOENT'
        ? 'not_found'
        : result.status === 0
          ? 'no_verdict'
          : 'failed';
  return {
    status: 'invalid',
    reason: 'auth_check_unavailable',
    cause,
    ...(Number.isInteger(result.status)
      ? { exitCode: result.status }
      : cause === 'failed' && typeof result.signal === 'string'
        ? { signal: result.signal }
        : {}),
  };
}

/** Optional extension discovery never overrides an authenticated native configuration. */
export async function checkPiProviderAuth(binary, model, env = process.env) {
  const native = nativePiAuth(binary, model, env);
  if (native.status === 'ready') return native;
  const [provider, ...parts] = model.split('/');
  if (parts.length && listPiProviderSources(env).some((source) => source.id === provider)) {
    const catalog = await resolvePiProviderCatalog(env);
    const available = catalog.find((source) => source.id === provider);
    if (available?.models.some((entry) => entry.id === parts.join('/')))
      return { status: 'ready', provider };
  }
  return native;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkPiProviderAuth(process.argv[2], process.argv[3]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'ready' ? 0 : 1;
}
