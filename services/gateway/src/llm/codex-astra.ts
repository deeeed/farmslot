import type { Model, MutableModels } from '@earendil-works/pi-ai';

export const CODEX_ASTRA_MODEL = 'gpt-6.2-astra';

/** Shared factual model metadata; provider and transport are always explicit. */
export function codexAstraModel<TApi extends 'openai-codex-responses' | 'openai-responses'>(
  provider: string,
  api: TApi,
  baseUrl: string,
): Model<TApi> {
  return {
    id: CODEX_ASTRA_MODEL,
    name: 'GPT-6.2 Astra',
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
    // Official max output and standard list prices, checked 2026-11-18:
    // https://developers.openai.com/api/docs/models/gpt-6.2-astra.md
    // Cache write is the 30-minute short-context rate. The tier is input above 272K.
    // These rates are estimates only; they are not subscription billing evidence.
    maxTokens: 128_000,
    cost: {
      input: 8,
      output: 40,
      cacheRead: 0.4,
      cacheWrite: 10,
      tiers: [{ inputTokensAbove: 272_000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 }],
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
