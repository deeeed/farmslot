// OpenAI-compatible Pi providers: optional discovery, validated model configuration.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const DEFAULT_OLLAMA = '127.0.0.1:11434';
const PI_REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// Installed observability bundles keep the normalizer beside this reader.
const { normalizeLiteLlmModelInfo } = await import(
  existsSync(new URL('./litellm-model-info.mjs', import.meta.url))
    ? './litellm-model-info.mjs'
    : '../../packages/slot-config/src/litellm-model-info.mjs'
);

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

// Reserved even when their discovery is disabled, so a later configuration cannot collide.
const RESERVED_ROUTER_IDS = new Set([
  'ollama',
  'litellm',
  'lmstudio',
  'omlx',
  'xai',
  'anthropic',
  'openai',
  'amazon-bedrock',
  'azure',
  'azure-openai-responses',
  'openai-codex',
  'radius',
  'nvidia',
  'deepseek',
  'google',
  'google-vertex',
  'github-copilot',
  'openrouter',
  'vercel-ai-gateway',
  'groq',
  'cerebras',
  'zai',
  'zai-coding-cn',
  'mistral',
  'minimax',
  'minimax-cn',
  'moonshotai',
  'moonshotai-cn',
  'huggingface',
  'fireworks',
  'together',
  'baseten',
  'opencode',
  'opencode-go',
  'kimi-coding',
  'meta',
  'cloudflare-workers-ai',
  'cloudflare-ai-gateway',
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'qwen-token-plan-individual',
  'xiaomi',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-sgp',
  'ant-ling',
]);

/** The source kind owns environment names; the configured id owns model names. */
export function piRouterProviderId(env = process.env) {
  const id = env.FARMSLOT_PI_ROUTER_ID ?? 'router';
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(id) || RESERVED_ROUTER_IDS.has(id))
    throw new PiProviderConfigurationError(
      'FARMSLOT_PI_ROUTER_ID must be a lowercase provider id and must not collide with another provider',
    );
  return id;
}

export class PiModelListFormatError extends Error {}

/** `pi --list-models`: preserve native membership and order, removing duplicates. */
export function decodePiModelList(output) {
  const rows = stripVTControlCharacters(output)
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/));
  const header = rows.findIndex(
    ([provider, model]) => provider === 'provider' && model === 'model',
  );
  if (header < 0) throw new PiModelListFormatError('Missing Pi model list header.');
  const ids = rows
    .slice(header + 1)
    .flatMap(([provider, model]) =>
      model && /^[a-z0-9][\w.-]*$/i.test(provider) ? [`${provider}/${model}`] : [],
    );
  if (!ids.length) throw new PiModelListFormatError('Pi listed no models.');
  return [...new Set(ids)];
}

/** Pi's extension reports discovery separately from the native model table. Older nodes omit it. */
export function parsePiProviderDiscovery(output, ids) {
  const configuredProviders = [];
  let reported = false;
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let report;
    try {
      report = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      continue; // Unrelated CLI output is not a discovery report.
    }
    if (!report || report.type !== 'farmslot.pi-provider-discovery') continue;
    reported = true;
    if (!Array.isArray(report.sources))
      throw new PiModelListFormatError('Invalid Pi provider discovery report.');
    for (const source of report.sources) {
      if (
        !source ||
        typeof source !== 'object' ||
        typeof source.provider !== 'string' ||
        !/^[a-z0-9][\w.-]*$/i.test(source.provider) ||
        typeof source.configured !== 'boolean' ||
        (source.status !== 'ready' && source.status !== 'failed') ||
        typeof source.modelCount !== 'number' ||
        !Number.isSafeInteger(source.modelCount) ||
        source.modelCount < 0
      )
        throw new PiModelListFormatError('Invalid Pi provider discovery source.');
      if (!source.configured) continue;
      configuredProviders.push(source.provider);
      if (
        source.status === 'failed' ||
        (source.modelCount > 0 && !ids.some((id) => id.startsWith(`${source.provider}/`)))
      )
        throw new PiModelListFormatError(
          `Pi configured provider ${source.provider} discovery is incomplete.`,
        );
    }
  }
  return { configuredProviders, reported };
}

/** Run on the execution node. Only a renamed router needs worker discovery. */
export async function listPiModelCatalog(binary, env = process.env, opts = {}) {
  const routerId = piRouterProviderId(env);
  const list = (args) => {
    const result = spawnSync(binary, ['--list-models', ...args], {
      env,
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) throw new Error('Pi native model listing failed');
    return result;
  };
  const output = list(opts.args ?? []).stdout;
  const listed = decodePiModelList(output);
  const discovery = parsePiProviderDiscovery(output, listed);
  // Native RPC omits the worker extension, so its registry needs its own evidence.
  // Reuse the table when no extension arguments were supplied.
  let native = listed;
  if (opts.args?.length) {
    const result = list([]);
    const nativeOutput = result.stdout.trim();
    // Pi exits successfully without a table when its native registry is empty.
    const empty =
      !result.stderr.trim() &&
      (nativeOutput === 'No models available' ||
        /^No models available\. Use \/login to log into a provider via OAuth or API key\. See:\r?\n {2}([^\r\n]+[/\\]docs)[/\\]providers\.md\r?\n {2}\1[/\\]models\.md$/.test(
          nativeOutput,
        ));
    native = empty ? [] : decodePiModelList(nativeOutput);
  }
  if (routerId === 'router' || discovery.reported) {
    const aliases = {};
    if (routerId !== 'router' && discovery.configuredProviders.includes(routerId))
      for (const id of listed)
        if (id.startsWith(`${routerId}/`)) aliases[`router/${id.slice(routerId.length + 1)}`] = id;
    return {
      ids: listed,
      aliases,
      nativeIds: native,
      configuredProviders: discovery.configuredProviders,
    };
  }
  const reports = [];
  const sources = await resolvePiSources(
    listPiProviderSources(env).filter((source) => source.kind === 'router'),
    env,
    { ...opts, onDiscovery: (source) => reports.push(source) },
  );
  const aliases = {};
  const ids = new Set(listed);
  for (const source of sources) {
    // Provider registration replaces its entire model list, including legacy aliases.
    const replaced = new Set([source.id, ...(source.aliases ?? [])]);
    for (const id of ids) if (replaced.has(id.slice(0, id.indexOf('/')))) ids.delete(id);
    for (const model of source.models) {
      const canonical = `${source.id}/${model.id}`;
      ids.add(canonical);
      for (const alias of source.aliases ?? []) {
        const id = `${alias}/${model.id}`;
        aliases[id] = canonical;
        ids.delete(id);
      }
    }
  }
  if (!ids.size) throw new Error('Pi listed no models');
  const { configuredProviders } = parsePiProviderDiscovery(
    JSON.stringify({ type: 'farmslot.pi-provider-discovery', sources: reports }),
    [...ids],
  );
  return { ids: [...ids], aliases, nativeIds: native, configuredProviders };
}

export function listPiProviderSources(env = process.env) {
  const routerId = piRouterProviderId(env);
  const sources = [];
  if (env.FARMSLOT_PI_OLLAMA !== '0') {
    const ollama =
      env.FARMSLOT_PI_OLLAMA_URL || env.OLLAMA_BASE_URL || env.OLLAMA_HOST || DEFAULT_OLLAMA;
    sources.push({
      id: 'ollama',
      kind: 'ollama',
      name: 'Ollama',
      baseUrl: openaiBaseUrl(ollama),
      apiKey: env.OLLAMA_API_KEY || 'ollama',
    });
  }
  const litellmUrl = env.LITELLM_URL || env.LITELLM_BASE_URL;
  if (litellmUrl) {
    sources.push({
      id: 'litellm',
      kind: 'litellm',
      name: 'LiteLLM',
      baseUrl: openaiBaseUrl(litellmUrl),
      apiKey: env.LITELLM_API_KEY || 'local',
    });
  }
  const routerUrl = env.FARMSLOT_PI_ROUTER_URL;
  if (routerUrl && openaiBaseUrl(routerUrl) !== openaiBaseUrl(litellmUrl || '')) {
    sources.push({
      id: routerId,
      kind: 'router',
      ...(routerId === 'router' ? {} : { aliases: ['router'] }),
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
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 400,
    endpoint = 'models',
    idField = 'id',
    onFailure,
  } = {},
) {
  if (typeof fetchImpl !== 'function') {
    onFailure?.();
    return [];
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(`${baseUrl}/${endpoint}`, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      onFailure?.();
      return [];
    }
    const body = await response.json();
    if (!Array.isArray(body?.data)) {
      onFailure?.();
      return [];
    }
    const rows = body.data;
    return rows.filter((row) => typeof row?.[idField] === 'string' && row[idField].trim());
  } catch {
    // Optional discovery remains usable by workers; catalog reads receive a safe failure signal.
    onFailure?.();
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export class PiProviderConfigurationError extends Error {}

/** Pi replaces extension model arrays; retain the statically composed models for workers too. */
export async function preservePiStaticModels(catalog, loadStaticRuntime, env = process.env) {
  if (catalog.length === 0) return catalog;
  const configuredDir = env.PI_CODING_AGENT_DIR;
  const agentDir = configuredDir
    ? configuredDir.replace(/^~(?=\/|$)/, homedir())
    : path.join(homedir(), '.pi', 'agent');
  const modelsPath = path.join(agentDir, 'models.json');
  if (!existsSync(modelsPath)) return catalog;
  try {
    // Pi's loader resolves its own SDK. Reuse its JSONC parsing, defaults and
    // overrides without refreshing catalogs or looking up credentials.
    const runtime = await loadStaticRuntime(modelsPath);
    if (runtime.getError()) throw new PiProviderConfigurationError('Invalid pi static models');
    return catalog.map((source) => {
      const name = `FARMSLOT_PI_${source.kind.toUpperCase()}_MODEL_LIMITS`;
      const limits = configuredModelLimits(env[name], name);
      const discovered = new Map(source.models.map((model) => [model.id, model]));
      return {
        ...source,
        models: [
          ...new Map([
            ...discovered,
            ...runtime.getModels(source.id).map((model) => {
              // Static defaults must not erase the pool's declared reasoning support.
              // Keep discovery's endpoint validation and supported effort levels.
              const live = discovered.get(model.id);
              return [
                model.id,
                live && limits.get(model.id)?.reasoning !== undefined
                  ? { ...model, reasoning: live.reasoning, thinkingLevelMap: live.thinkingLevelMap }
                  : model,
              ];
            }),
          ]).values(),
        ],
      };
    });
  } catch {
    // Do not let optional discovery hide a failed static-model composition or
    // include configuration contents in a public catalog error.
    throw new PiProviderConfigurationError('Cannot preserve pi static models');
  }
}

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
  if (typeof value === 'object' && typeof value.default_enabled === 'boolean')
    return value.default_enabled;
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

/** @returns {Record<string, string | null> | undefined} */
function reportedThinkingMap(info) {
  /** @type {Record<string, string | null>} */
  const map = {};
  for (const level of PI_REASONING_LEVELS) {
    if (Array.isArray(info.reasoning_effort_levels)) {
      map[level] = info.reasoning_effort_levels.includes(level) ? level : null;
    } else {
      const key = `supports_${level}_reasoning_effort`;
      const supported = reasoningSetting(info[key], key);
      if (supported !== undefined) map[level] = supported ? level : null;
    }
  }
  return Object.keys(map).length ? map : undefined;
}

/** Pi requires numeric SDK rates; nullable request metadata owns their accounting validity. */
export function piSdkModels(models) {
  const rates = (cost) => ({
    input: cost?.input ?? 0,
    output: cost?.output ?? 0,
    cacheRead: cost?.cacheRead ?? 0,
    cacheWrite: cost?.cacheWrite ?? 0,
  });
  return models.map((model) => ({
    ...model,
    cost: {
      ...rates(model.cost),
      ...(model.cost?.tiers
        ? {
            tiers: model.cost.tiers.map((tier) => ({
              ...rates(tier),
              inputTokensAbove: tier.inputTokensAbove,
            })),
          }
        : {}),
    },
  }));
}

function modelEntry(row, source, defaults, info = {}, configured = {}) {
  const provider = source.id;
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
      `${provider}/${row.id} reasoning`,
    ) ??
    configured.reasoning ??
    defaults.reasoning;
  if ((source.kind === 'router' || configured.reasoning === true) && !reasoning)
    throw new PiProviderConfigurationError(
      `Model ${provider}/${row.id} requires reasoning for code work`,
    );
  return {
    id: row.id,
    name: row.id,
    reasoning,
    ...(source.kind === 'router'
      ? { thinkingLevelMap: Object.fromEntries(PI_REASONING_LEVELS.map((level) => [level, level])) }
      : reasoning && source.kind === 'litellm'
        ? { thinkingLevelMap: reportedThinkingMap(info) }
        : {}),
    input: ['text', 'image'],
    cost: normalizeLiteLlmModelInfo(info, reasoning),
    contextWindow: modelLimit(
      context,
      configured.contextWindow,
      defaults.contextWindow,
      `${provider}/${row.id} context`,
    ),
    maxTokens: modelLimit(
      output,
      configured.maxTokens,
      defaults.maxTokens,
      `${provider}/${row.id} maxTokens`,
    ),
  };
}

export async function resolvePiProviderCatalog(env = process.env, opts = {}) {
  return resolvePiSources(listPiProviderSources(env), env, opts);
}

async function resolvePiSources(sources, env, opts) {
  const resolved = await Promise.all(
    sources.map(async (source) => {
      const prefix = `FARMSLOT_PI_${source.kind.toUpperCase()}`;
      const defaults = {
        contextWindow: positiveInteger(env[`${prefix}_CONTEXT`], `${prefix}_CONTEXT`) ?? 128000,
        maxTokens: positiveInteger(env[`${prefix}_MAX_TOKENS`], `${prefix}_MAX_TOKENS`) ?? 8192,
        reasoning:
          reasoningSetting(env[`${prefix}_REASONING`], `${prefix}_REASONING`) ??
          source.kind === 'router',
      };
      const overrides = configuredModelLimits(
        env[`${prefix}_MODEL_LIMITS`],
        `${prefix}_MODEL_LIMITS`,
      );
      const fetchOptions = { timeoutMs: source.kind === 'litellm' ? 5000 : 400, ...opts };
      let failed = false;
      const [rows, infos] = await Promise.all([
        fetchOpenAiModels(source.baseUrl, source.apiKey, {
          ...fetchOptions,
          onFailure: () => {
            failed = true;
          },
        }),
        source.kind === 'litellm'
          ? fetchOpenAiModels(source.baseUrl, source.apiKey, {
              ...fetchOptions,
              endpoint: 'model/info',
              idField: 'model_name',
            })
          : [],
      ]);
      opts.onDiscovery?.({
        provider: source.id,
        // Shell-inherited Ollama endpoints remain optional until Farmslot explicitly opts in.
        configured:
          source.id !== 'ollama' ||
          Boolean(env.FARMSLOT_PI_OLLAMA === '1' || env.FARMSLOT_PI_OLLAMA_URL),
        status: failed ? 'failed' : 'ready',
        modelCount: rows.length,
      });
      if (rows.length === 0) return null;
      const infoById = new Map(infos.map((entry) => [entry.model_name, entry.model_info]));
      return {
        ...source,
        models: rows.map((row) =>
          modelEntry(row, source, defaults, infoById.get(row.id) ?? {}, overrides.get(row.id)),
        ),
      };
    }),
  );
  return resolved.filter(Boolean);
}

function piReasoningMismatch(model, requestedEffort, detail, kind = model.provider) {
  return new PiProviderConfigurationError(
    `PI_REASONING_EFFORT_MISMATCH: Model ${model.provider}/${model.id} requested ${requestedEffort}, ${detail}. ` +
      `Declare reasoning=true for the model in FARMSLOT_PI_${kind.toUpperCase()}_MODEL_LIMITS, or choose a reasoning model / no thinking (--thinking off).`,
  );
}

/** Check the selected model before Pi can clamp thinking and enter the SDK retry loop. */
export function assertPiModelThinking(model, requestedEffort, kind = model?.provider) {
  if (!model || !requestedEffort || requestedEffort === 'off') return;
  if (!model.reasoning)
    throw piReasoningMismatch(
      model,
      requestedEffort,
      'but the model declares reasoning=false',
      kind,
    );
  if (model.thinkingLevelMap?.[requestedEffort] === null)
    throw piReasoningMismatch(
      model,
      requestedEffort,
      'but the model declares that level unsupported',
      kind,
    );
}

/** @typedef {{ provider: string, model: string, contextWindow: number, maxTokens: number, reasoning: boolean, effort?: string, requestedMaxTokens?: number, cost: PiModelCostMetadata | null }} PiModelRequestConfiguration */

/**
 * Refuse undeclared effort changes before sending; record actual wire effort.
 * @param {(configuration: PiModelRequestConfiguration) => void} [onRequest]
 * @param {string} [requestedEffort]
 * @param {(error: PiProviderConfigurationError) => void} [onMismatch] Fatal worker handler, outside SDK retries.
 */
export function providerReasoningFetch(
  fetchImpl,
  providers = [],
  onRequest,
  requestedEffort,
  onMismatch,
) {
  const byUrl = new Map(providers.map((source) => [`${source.baseUrl}/chat/completions`, source]));
  if (byUrl.size === 0) return fetchImpl;
  let mismatchReported = false;
  return async (input, options = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const provider = byUrl.get(url);
    if (provider) {
      const raw = options.body ?? (input instanceof Request ? await input.clone().text() : '');
      const payload = JSON.parse(raw);
      const model = provider.models.find((entry) => entry.id === payload.model);
      const effort = payload.reasoning_effort;
      if (model && requestedEffort) {
        const mapped = model.thinkingLevelMap?.[requestedEffort];
        const expected =
          mapped === undefined ? (requestedEffort === 'off' ? undefined : requestedEffort) : mapped;
        if (effort !== expected) {
          const error = piReasoningMismatch(
            { ...model, provider: provider.id },
            requestedEffort,
            `mapped to ${expected}, but wire effort was ${effort}`,
            provider.kind,
          );
          if (!mismatchReported) {
            mismatchReported = true;
            // The worker requests orderly shutdown here; SDKs otherwise hide fetch
            // exceptions behind a retryable "Connection error."
            if (onMismatch) onMismatch(error);
            else console.error(error.message);
          }
          throw error;
        }
      }
      if (model && effort !== undefined && (provider.kind === 'router' || model.reasoning)) {
        if (
          !model.reasoning ||
          typeof effort !== 'string' ||
          !effort.trim() ||
          ['off', 'none'].includes(effort)
        )
          throw new PiProviderConfigurationError(
            `Model ${provider.id}/${model.id} requires a reasoning effort; refusing a non-reasoning request`,
          );
      }
      if (model) {
        onRequest?.({
          provider: provider.id,
          model: model.id,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          requestedMaxTokens: payload.max_completion_tokens ?? payload.max_tokens,
          reasoning: model.reasoning,
          effort,
          cost: model.cost ?? null,
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
  if (
    parts.length &&
    listPiProviderSources(env).some(
      (source) => source.id === provider || source.aliases?.includes(provider),
    )
  ) {
    const catalog = await resolvePiProviderCatalog(env);
    const available = catalog.find(
      (source) => source.id === provider || source.aliases?.includes(provider),
    );
    if (available?.models.some((entry) => entry.id === parts.join('/')))
      return { status: 'ready', provider };
  }
  return native;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const listing = process.argv[2] === '--list-models';
  const result = listing
    ? await listPiModelCatalog(process.argv[3], process.env, { args: process.argv.slice(4) })
    : await checkPiProviderAuth(process.argv[2], process.argv[3]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = listing || result.status === 'ready' ? 0 : 1;
}
