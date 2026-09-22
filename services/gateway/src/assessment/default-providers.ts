import { createAssessmentProviderRegistry } from './provider.js';
import { createTypeSafeProvider } from './typesafe.js';

/** Adapter composition stays here; consumers select a provider by its configured ID. */
export function defaultAssessmentProviders(fetchImpl?: typeof fetch) {
  return createAssessmentProviderRegistry([createTypeSafeProvider(fetchImpl)]);
}
