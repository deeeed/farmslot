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

/** Controlled result codes. Callers persist these instead of upstream response text. */
export const ASSESSMENT_RESPONSE_VALIDATION_ERROR =
  'Assessment provider response failed validation';
export const TRIAGE_SPEND_BOUND_EXCEEDED = 'spend-bound-exceeded';
export const TRIAGE_SPEND_BOUND_UNVERIFIABLE = 'spend-bound-unverifiable';

export function createAssessmentProviderRegistry(
  providers: readonly AssessmentProvider[],
): AssessmentProviderRegistry {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return {
    get: (id) => byId.get(id),
    list: () => providers,
  };
}

/** A provider replied, but its output cannot satisfy the assessment contract. */
export class AssessmentResponseError extends Error {
  override name = 'AssessmentResponseError';
  constructor(
    message: string,
    readonly attempted = true,
    readonly usage?: Omit<AssessmentUsage, 'provider' | 'requestedModel'>,
    readonly returnedModel?: string,
    /** The provider returned a response, but it did not meet the adapter contract. */
    readonly responseReceived = false,
  ) {
    super(message);
  }
}
