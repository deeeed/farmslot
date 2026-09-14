import type { Model, MutableModels } from '@earendil-works/pi-ai';

export const CODEX_ASTRA_MODEL = 'gpt-6-astra';

/** Shared factual model metadata; provider and transport are always explicit. */
export function codexAstraModel<TApi extends 'openai-codex-responses' | 'openai-responses'>(
  provider: string,
  api: TApi,
  baseUrl: string,
): Model<TApi> {
  return {
    id: CODEX_ASTRA_MODEL,
    name: 'GPT-6 Astra',
    api,
    provider,
    baseUrl,
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },
    input: ['text', 'image'],
    // Codex 0.154.0's account-native catalog exposes an effective 272K window.
    // The API model advertises 1,050,000; do not promise that larger Codex allowance.
    contextWindow: 272_000,
    // Official model ceiling and API list prices, checked 2026-09-14:
    // https://developers.openai.com/api/docs/models/gpt-6-astra.md
    // These rates are estimates only; they are not subscription billing evidence.
    maxTokens: 128_000,
    cost: {
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
      tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
    },
  };
}

/** Supplement PI's static catalog without replacing its transport or authentication. */
export function registerCodexAstra(models: MutableModels): void {
  const provider = models.getProvider('openai-codex');
  if (!provider || models.getModel(provider.id, CODEX_ASTRA_MODEL)) return;
  if (!provider.baseUrl) throw new Error('Codex provider has no configured base URL');
  const astra = codexAstraModel(provider.id, 'openai-codex-responses', provider.baseUrl);
  models.setProvider({
    ...provider,
    getModels: () => {
      const current = provider.getModels();
      return current.some((model) => model.id === CODEX_ASTRA_MODEL)
        ? current
        : [...current, astra];
    },
  });
}

/** PI's API list-price calculation does not establish an OAuth subscription charge. */
export function reportedLlmCost(provider: string, cost: number | undefined): number | undefined {
  return provider === 'openai-codex' || provider === 'codex-lb' ? undefined : cost;
}

export function requiresExactAstraProvider(model: string): boolean {
  return model === CODEX_ASTRA_MODEL;
}
