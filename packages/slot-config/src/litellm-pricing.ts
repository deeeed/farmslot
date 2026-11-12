import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { PiModelCostMetadata } from './session-usage.js';

const DAY_MS = 86_400_000;
const fields = {
  input_cost_per_token: 'input',
  output_cost_per_token: 'output',
  cache_read_input_token_cost: 'cacheRead',
  cache_creation_input_token_cost: 'cacheWrite',
} as const;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rate(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0
    ? number * 1_000_000
    : null;
}

/** Gateway rates are per token; the existing Pi accounting type uses USD per million. */
export function parseLiteLlmPrices(payload: unknown): Map<string, PiModelCostMetadata> {
  const prices = new Map<string, PiModelCostMetadata>();
  if (!object(payload) || !Array.isArray(payload.data)) return prices;
  for (const row of payload.data) {
    if (!object(row) || typeof row.model_name !== 'string' || !object(row.model_info)) continue;
    const info = row.model_info;
    const cost: PiModelCostMetadata = {
      input: rate(info.input_cost_per_token),
      output: rate(info.output_cost_per_token),
      cacheRead: rate(info.cache_read_input_token_cost),
      cacheWrite: rate(info.cache_creation_input_token_cost),
      ...(info.cache_creation_input_token_cost_above_1hr != null
        ? { cacheWrite1h: rate(info.cache_creation_input_token_cost_above_1hr) }
        : {}),
      ...(info.output_cost_per_reasoning_token != null
        ? { reasoningOutput: rate(info.output_cost_per_reasoning_token) }
        : {}),
    };
    const thresholds = new Set<number>();
    for (const key of Object.keys(info)) {
      const match =
        /^(?:input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_(\d+)k_tokens$/.exec(
          key,
        );
      if (match && info[key] != null) thresholds.add(Number(match[1]));
    }
    if (thresholds.size)
      cost.tiers = [...thresholds]
        .sort((a, b) => a - b)
        .map((threshold) => {
          const tier = { ...cost, inputTokensAbove: threshold * 1000 };
          for (const [field, category] of Object.entries(fields)) {
            const value = info[`${field}_above_${threshold}k_tokens`];
            if (value != null) tier[category] = rate(value);
          }
          return tier;
        });
    prices.set(row.model_name, cost);
  }
  return prices;
}

interface LiteLlmPricingOptions {
  baseUrl?: string;
  apiKey?: string;
  cacheDir?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/** A failed refresh leaves work explicitly unpriced, rather than silently using expired prices. */
export async function loadLiteLlmPrices(
  options: LiteLlmPricingOptions = {},
): Promise<Map<string, PiModelCostMetadata>> {
  const baseUrl = (
    options.baseUrl ??
    process.env.LITELLM_URL ??
    process.env.LITELLM_BASE_URL
  )?.replace(/\/+$/, '');
  const apiKey = options.apiKey ?? process.env.LITELLM_API_KEY;
  if (!baseUrl || !apiKey) return new Map();
  const cacheDir =
    options.cacheDir ??
    process.env.FARMSLOT_LITELLM_PRICING_CACHE_DIR ??
    path.join(os.homedir(), '.cache', 'farmslot', 'litellm-prices');
  const identity = createHash('sha256').update(`${baseUrl}\n${apiKey}`).digest('hex');
  const file = path.join(cacheDir, `${identity}.json`);
  const now = (options.now ?? Date.now)();
  try {
    const cached: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (
      object(cached) &&
      typeof cached.fetchedAt === 'number' &&
      now >= cached.fetchedAt &&
      now - cached.fetchedAt < DAY_MS
    )
      return parseLiteLlmPrices(cached);
  } catch (error) {
    // Missing or damaged caches are rebuilt from the gateway. Other I/O errors are surfaced.
    if (!(error instanceof SyntaxError) && !(object(error) && error.code === 'ENOENT')) throw error;
  }
  let payload: unknown;
  try {
    const url = `${baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`}/model/info`;
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return new Map();
    payload = await response.json();
  } catch {
    // Network/JSON failures cannot justify a charge. Callers retain tokens with an unpriced reason.
    return new Map();
  }
  const prices = parseLiteLlmPrices(payload);
  if (!prices.size || !object(payload) || !Array.isArray(payload.data)) return prices;
  // Persist only names and prices, never gateway params, credentials or deployment metadata.
  const data = payload.data.filter(object).map((row) => ({
    model_name: row.model_name,
    model_info: object(row.model_info)
      ? Object.fromEntries(
          Object.entries(row.model_info).filter(
            ([key]) =>
              key in fields ||
              key === 'cache_creation_input_token_cost_above_1hr' ||
              key === 'output_cost_per_reasoning_token' ||
              /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_\d+k_tokens$/.test(
                key,
              ),
          ),
        )
      : {},
  }));
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ fetchedAt: now, data }), { mode: 0o600 });
  await rename(temporary, file);
  return prices;
}
