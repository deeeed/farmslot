// OpenAI-compatible PI providers (Ollama, LiteLLM, custom router). Fail open.
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

export async function fetchOpenAiModelIds(
  baseUrl,
  apiKey,
  { fetchImpl = globalThis.fetch, timeoutMs = 400 } = {},
) {
  if (typeof fetchImpl !== 'function') return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(`${baseUrl}/models`, { headers, signal: controller.signal });
    if (!response.ok) return [];
    const body = await response.json();
    const rows = Array.isArray(body?.data) ? body.data : [];
    return rows.map((row) => (typeof row?.id === 'string' ? row.id : '')).filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function modelEntry(id) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

export async function resolvePiProviderCatalog(env = process.env, opts = {}) {
  const sources = listPiProviderSources(env);
  const resolved = await Promise.all(
    sources.map(async (source) => {
      const ids = await fetchOpenAiModelIds(source.baseUrl, source.apiKey, opts);
      if (ids.length === 0) return null;
      return { ...source, models: ids.map(modelEntry) };
    }),
  );
  return resolved.filter(Boolean);
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
    return { status: 'invalid', reason: 'auth_check_unavailable' };
  }
  return { status: 'invalid', reason: 'auth_check_unavailable' };
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
