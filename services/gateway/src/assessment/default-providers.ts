import { CODEX_LB_BASE_URL } from '../llm/codex-lb.js';

import { createLlmAssessmentProvider } from './llm.js';
import { createAssessmentProviderRegistry } from './provider.js';
import { createTypeSafeProvider } from './typesafe.js';

/** Adapter composition stays here; consumers select a provider by its configured ID. */
export function defaultAssessmentProviders(fetchImpl?: typeof fetch) {
  return createAssessmentProviderRegistry([
    createTypeSafeProvider(fetchImpl),
    createLlmAssessmentProvider(
      {
        id: 'codex-lb',
        credentialEnv: 'CODEX_LB_API_KEY',
        defaultModel: 'gpt-6-luna',
        baseUrl: CODEX_LB_BASE_URL,
      },
      fetchImpl,
    ),
  ]);
}
