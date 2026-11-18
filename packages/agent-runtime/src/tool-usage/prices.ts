// Static per-model prices, USD per million tokens. Session receipts and the live spend
// read the same table; a model with no entry has no cost rather than an invented one.
export interface ClaudePricing {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

export interface OpenaiPricing {
  input: number;
  output: number;
  /** Rate for input tokens served from the prompt cache, when OpenAI lists one. */
  cached_input?: number;
}

// Conservative/optional estimates. If the model doesn't match any entry we omit
// cost_usd rather than inventing a value.
export const CLAUDE_PRICING: Record<string, ClaudePricing> = {
  // Company LiteLLM catalog, USD per million tokens.
  'claude-opus-5-5': { input: 4, output: 20, cache_write: 5, cache_read: 0.4 },
  'claude-sonnet-5-5': { input: 2, output: 10, cache_write: 2.5, cache_read: 0.2 },
  'claude-opus-4-6': { input: 15.0, output: 75.0, cache_write: 18.75, cache_read: 1.5 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.3 },
  'claude-haiku-4-5': { input: 0.8, output: 4.0, cache_write: 1.0, cache_read: 0.08 },
};

export const OPENAI_PRICING: Record<string, OpenaiPricing> = {
  // https://developers.openai.com/api/docs/pricing
  // Standard short-context rates, USD per 1M tokens. Checked 2026-11-18.
  // GPT-5.6 Sol is the published promotional rate through 2026-11-30.
  'gpt-6.2-astra': { input: 8.0, cached_input: 0.4, output: 40.0 },
  'gpt-6.2-sol': { input: 2.0, cached_input: 0.1, output: 10.0 },
  'gpt-6-astra': { input: 10.0, cached_input: 1.0, output: 50.0 },
  'gpt-6.1-sol': { input: 2.0, cached_input: 0.1, output: 10.0 },
  'gpt-6-sol': { input: 2.0, cached_input: 0.2, output: 10.0 },
  'gpt-5.6-sol': { input: 4.0, cached_input: 0.4, output: 20.0 },
  'gpt-5.6-terra': { input: 2.0, cached_input: 0.2, output: 12.0 },
  'gpt-5.6-luna': { input: 0.2, cached_input: 0.02, output: 1.2 },
  'gpt-5.6': { input: 4.0, cached_input: 0.4, output: 20.0 }, // bare alias → Sol
  'gpt-5.5': { input: 5.0, cached_input: 0.5, output: 30.0 },
  'gpt-5.4': { input: 2.5, cached_input: 0.25, output: 15.0 },
};

/**
 * OpenAI counts cached tokens inside input. They bill at the cached rate when the model
 * lists one; without a cached rate every input token bills at the input rate.
 */
export function openaiCostUsd(
  prices: OpenaiPricing,
  tokens: { input: number; cachedInput: number; output: number },
): number {
  const cached = prices.cached_input === undefined ? 0 : Math.min(tokens.cachedInput, tokens.input);
  return (
    ((tokens.input - cached) * prices.input +
      cached * (prices.cached_input ?? 0) +
      tokens.output * prices.output) /
    1_000_000
  );
}
