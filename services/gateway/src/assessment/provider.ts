import type { AssessmentAnswer, AssessmentQuestions, AssessmentUsage } from '@farmslot/protocol';

import type { AssessmentState } from './types.js';

export interface AssessmentProviderRequest {
  state: AssessmentState;
  questions: AssessmentQuestions;
  model: string;
  apiKey: string;
  signal: AbortSignal;
}

export interface AssessmentProvider {
  readonly id: string;
  readonly defaultModel: string;
  readonly credentialEnv: string;
  readonly capabilities: readonly ('choice' | 'score' | 'boolean')[];
  assess(request: AssessmentProviderRequest): Promise<{
    returnedModel?: string;
    answers: Record<string, AssessmentAnswer>;
    usage: Omit<AssessmentUsage, 'provider' | 'requestedModel'>;
  }>;
}

export interface AssessmentProviderRegistry {
  get(id: string): AssessmentProvider | undefined;
  list(): readonly AssessmentProvider[];
}

export function createAssessmentProviderRegistry(
  providers: readonly AssessmentProvider[],
): AssessmentProviderRegistry {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return {
    get: (id) => byId.get(id),
    list: () => providers,
  };
}
