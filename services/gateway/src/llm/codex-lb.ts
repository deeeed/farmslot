import { createProvider, envApiKeyAuth, type MutableModels } from '@earendil-works/pi-ai';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';

import { codexAstraModels, codexLbConfiguredModel } from './codex-astra.js';
import { getLLMConfig } from './config.js';

export const CODEX_LB_PROVIDER = 'codex-lb';
// The LB's SDK-compatible route differs from the native Codex /backend-api/codex route.
// https://soju06.github.io/codex-lb/client-setup/
export const CODEX_LB_BASE_URL = 'http://127.0.0.1:2455/v1';

/**
 * Explicit local LB route. Its client key never becomes upstream OAuth material.
 *
 * Besides the Astra ids, the LB serves whatever its accounts' plans support, so a model id
 * configured for a codex-lb tier (`tierModels['codex-lb']`) is routed here too. The list is read
 * on each lookup: a tier changed in Settings routes without a restart.
 */
export function registerCodexLb(models: MutableModels): void {
  if (models.getProvider(CODEX_LB_PROVIDER)) return;
  const provider = createProvider({
    id: CODEX_LB_PROVIDER,
    name: 'Codex load balancer',
    baseUrl: CODEX_LB_BASE_URL,
    auth: { apiKey: envApiKeyAuth('Codex load balancer client key', ['CODEX_LB_API_KEY']) },
    models: codexAstraModels(CODEX_LB_PROVIDER, 'openai-responses', CODEX_LB_BASE_URL),
    api: openAIResponsesApi(),
  });
  models.setProvider({
    ...provider,
    getModels: () => {
      const current = provider.getModels();
      const configured = Object.values(getLLMConfig().tierModels?.[CODEX_LB_PROVIDER] ?? {})
        .filter((id): id is string => typeof id === 'string')
        .filter((id, index, ids) => ids.indexOf(id) === index)
        .filter((id) => !current.some((model) => model.id === id))
        .map((id) =>
          codexLbConfiguredModel(
            id,
            // The OpenAI API catalog's entry, when PI has one, carries the model's own effort
            // levels and limits; an id PI does not know gets the Astra shape.
            models.getModel('openai', id),
            CODEX_LB_PROVIDER,
            CODEX_LB_BASE_URL,
          ),
        );
      return configured.length === 0 ? current : [...current, ...configured];
    },
  });
}
