// Dependency-free model/info normalization shared by dispatch and transcript accounting.
const FIELDS = {
  input_cost_per_token: 'input',
  output_cost_per_token: 'output',
  cache_read_input_token_cost: 'cacheRead',
  cache_creation_input_token_cost: 'cacheWrite',
};
const PRICE_TIER =
  /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_(\d+)k_tokens$/;

export function isLiteLlmPriceField(key) {
  return (
    Object.hasOwn(FIELDS, key) ||
    key === 'cache_creation_input_token_cost_above_1hr' ||
    key === 'output_cost_per_reasoning_token' ||
    PRICE_TIER.test(key)
  );
}

function rate(value) {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof numeric === 'number' &&
    Number.isFinite(numeric) &&
    numeric >= 0 &&
    Number.isFinite(numeric * 1_000_000)
    ? numeric * 1_000_000
    : null;
}

/** @returns {import('./litellm-model-info.mjs').PiModelCostMetadata | null} */
export function normalizeLiteLlmModelInfo(info, reasoning = true) {
  const cost = {
    input: rate(info.input_cost_per_token),
    output: rate(info.output_cost_per_token),
    cacheRead: rate(info.cache_read_input_token_cost),
    cacheWrite: rate(info.cache_creation_input_token_cost),
    ...(info.cache_creation_input_token_cost_above_1hr != null
      ? { cacheWrite1h: rate(info.cache_creation_input_token_cost_above_1hr) }
      : {}),
    ...(reasoning && info.output_cost_per_reasoning_token != null
      ? { reasoningOutput: rate(info.output_cost_per_reasoning_token) }
      : {}),
  };
  const tiers = new Map();
  for (const [key, value] of Object.entries(info)) {
    const match = PRICE_TIER.exec(key);
    if (!match || value == null) continue;
    const threshold = Number(match[2]) * 1000;
    const tier = tiers.get(threshold) ?? { ...cost, inputTokensAbove: threshold };
    tier[FIELDS[match[1]]] = rate(value);
    tiers.set(threshold, tier);
  }
  if (tiers.size)
    return {
      ...cost,
      tiers: [...tiers.values()].sort((a, b) => a.inputTokensAbove - b.inputTokensAbove),
    };
  return Object.values(cost).some((value) => value !== null) ? cost : null;
}
