import { createProvider, envApiKeyAuth, type MutableModels } from '@earendil-works/pi-ai';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';

import { codexAstraModel } from './codex-astra.js';

export const CODEX_LB_PROVIDER = 'codex-lb';
// The LB's SDK-compatible route differs from the native Codex /backend-api/codex route.
// https://soju06.github.io/codex-lb/client-setup/
export const CODEX_LB_BASE_URL = 'http://127.0.0.1:2455/v1';

/** Explicit local LB route. Its client key never becomes upstream OAuth material. */
export function registerCodexLb(models: MutableModels): void {
  if (models.getProvider(CODEX_LB_PROVIDER)) return;
  models.setProvider(
    createProvider({
      id: CODEX_LB_PROVIDER,
      name: 'Codex load balancer',
      baseUrl: CODEX_LB_BASE_URL,
      auth: { apiKey: envApiKeyAuth('Codex load balancer client key', ['CODEX_LB_API_KEY']) },
      models: [codexAstraModel(CODEX_LB_PROVIDER, 'openai-responses', CODEX_LB_BASE_URL)],
      api: openAIResponsesApi(),
    }),
  );
}
