// OpenAI-compatible PI providers (Ollama, LiteLLM, custom router). Fail open.

const DEFAULT_OLLAMA = '127.0.0.1:11434';

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
