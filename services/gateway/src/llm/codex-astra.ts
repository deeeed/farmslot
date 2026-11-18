import type { Model, MutableModels } from '@earendil-works/pi-ai';

export const CODEX_ASTRA_MODEL = 'gpt-6.2-astra';
/** Saved pins keep the previous Astra id. New defaults use CODEX_ASTRA_MODEL. */
export const CODEX_PREVIOUS_ASTRA_MODEL = 'gpt-6-astra';

const ASTRA_THINKING_LEVELS = {
  off: null,
  minimal: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
} as const;

type AstraSpec = {
  id: string;
  name: string;
  cost: NonNullable<Model<string>['cost']>;
};

const CURRENT_ASTRA: AstraSpec = {
  id: CODEX_ASTRA_MODEL,
  name: 'GPT-6.2 Astra',
  // Official max output and standard list prices, checked 2026-11-18:
  // https://developers.openai.com/api/docs/models/gpt-6.2-astra.md
  // Cache write is the 30-minute short-context rate. The tier is input above 272K.
  cost: {
    input: 8,
    output: 40,
    cacheRead: 0.4,
    cacheWrite: 10,
    tiers: [{ inputTokensAbove: 272_000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 }],
  },
};

const PREVIOUS_ASTRA: AstraSpec = {
  id: CODEX_PREVIOUS_ASTRA_MODEL,
  name: 'GPT-6 Astra',
  // Official model ceiling and API list prices, checked 2026-09-14:
  // https://developers.openai.com/api/docs/models/gpt-6-astra.md
  cost: {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
  },
};

/** Shared factual model metadata; provider and transport are always explicit. */
function codexAstraDescriptor<TApi extends 'openai-codex-responses' | 'openai-responses'>(
  spec: AstraSpec,
  provider: string,
  api: TApi,
  baseUrl: string,
): Model<TApi> {
  return {
    id: spec.id,
    name: spec.name,
    api,
    provider,
    baseUrl,
    reasoning: true,
    thinkingLevelMap: ASTRA_THINKING_LEVELS,
    input: ['text', 'image'],
    // Codex 0.154.0's account-native catalog exposes an effective 272K window.
    // The API model advertises 1,050,000; do not promise that larger Codex allowance.
    contextWindow: 272_000,
    // These rates are estimates only; they are not subscription billing evidence.
    maxTokens: 128_000,
    cost: spec.cost,
  };
}

export function codexAstraModel<TApi extends 'openai-codex-responses' | 'openai-responses'>(
  provider: string,
  api: TApi,
  baseUrl: string,
): Model<TApi> {
  return codexAstraDescriptor(CURRENT_ASTRA, provider, api, baseUrl);
}

export function previousCodexAstraModel<TApi extends 'openai-codex-responses' | 'openai-responses'>(
  provider: string,
  api: TApi,
  baseUrl: string,
): Model<TApi> {
  return codexAstraDescriptor(PREVIOUS_ASTRA, provider, api, baseUrl);
}

export function codexAstraModels<TApi extends 'openai-codex-responses' | 'openai-responses'>(
  provider: string,
  api: TApi,
  baseUrl: string,
): Model<TApi>[] {
  return [CURRENT_ASTRA, PREVIOUS_ASTRA].map((spec) =>
    codexAstraDescriptor(spec, provider, api, baseUrl),
  );
}

/** Supplement PI's static catalog without replacing its transport or authentication. */
export function registerCodexAstra(models: MutableModels): void {
  const provider = models.getProvider('openai-codex');
  if (!provider) return;
  if (!provider.baseUrl) throw new Error('Codex provider has no configured base URL');
  const missing = codexAstraModels(provider.id, 'openai-codex-responses', provider.baseUrl).filter(
    (model) => !models.getModel(provider.id, model.id),
  );
  if (missing.length === 0) return;
  models.setProvider({
    ...provider,
    getModels: () => {
      const current = provider.getModels();
      const added = missing.filter((model) => !current.some((entry) => entry.id === model.id));
      return added.length === 0 ? current : [...current, ...added];
    },
  });
}

/** PI's API list-price calculation does not establish an OAuth subscription charge. */
export function reportedLlmCost(provider: string, cost: number | undefined): number | undefined {
  return provider === 'openai-codex' || provider === 'codex-lb' ? undefined : cost;
}

export function requiresExactAstraProvider(model: string): boolean {
  return model === CODEX_ASTRA_MODEL || model === CODEX_PREVIOUS_ASTRA_MODEL;
}
