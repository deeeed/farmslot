import { createHash } from 'node:crypto';

import type {
  AssessmentJsonValue,
  AssessmentRequest,
  AssessmentResult,
  AssessmentStatusResult,
} from '@farmslot/protocol';

import { getAssessmentConfig } from './config.js';
import { defaultAssessmentProviders } from './default-providers.js';
import { prepareAssessmentInput } from './input.js';
import {
  ASSESSMENT_RESPONSE_VALIDATION_ERROR,
  type AssessmentProviderRegistry,
  AssessmentResponseError,
} from './provider.js';

const providers = defaultAssessmentProviders();

function canonical(value: AssessmentJsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function hash(value: AssessmentJsonValue): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function assessmentProviderStatus(): AssessmentStatusResult {
  let config;
  try {
    config = getAssessmentConfig();
  } catch {
    return {
      enabled: false,
      keyAvailable: false,
      providers: providers.list().map(({ id, defaultModel, capabilities }) => ({
        id,
        defaultModel,
        capabilities: [...capabilities],
      })),
      error: 'Assessment configuration unavailable',
    };
  }
  const provider = config.provider ? providers.get(config.provider) : undefined;
  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model ?? provider?.defaultModel,
    keyAvailable: Boolean(provider && process.env[provider.credentialEnv]?.trim()),
    providers: providers.list().map(({ id, defaultModel, capabilities }) => ({
      id,
      defaultModel,
      capabilities: [...capabilities],
    })),
  };
}

export async function assess(
  request: AssessmentRequest & { signal?: AbortSignal },
  registry: AssessmentProviderRegistry = providers,
): Promise<AssessmentResult> {
  let config;
  try {
    config = getAssessmentConfig();
  } catch {
    return {
      provider: request.provider,
      requestedModel: request.model,
      questionSchemaHash: hash(request.questions),
      status: 'unavailable',
      attempted: false,
      error: 'Assessment configuration unavailable',
    };
  }
  const providerId = request.provider ?? config.provider;
  const provider = providerId ? registry.get(providerId) : undefined;
  // A provider override must not inherit another provider's saved model.
  const model =
    request.model ??
    (request.provider && request.provider !== config.provider ? undefined : config.model) ??
    provider?.defaultModel;
  const base = {
    attempted: false,
    provider: providerId,
    requestedModel: model,
    questionSchemaHash: hash(request.questions),
  };
  // Saved config remains opt-in through enabled=true; a credential or provider
  // selection alone does nothing.
  if (!(request.enabled ?? config.enabled)) return { ...base, status: 'disabled' };
  if (!provider)
    return {
      ...base,
      status: 'unavailable',
      error: `unknown structured assessment provider: ${providerId}`,
    };
  if (!model) return { ...base, status: 'skipped', error: 'Select an assessment model' };
  const apiKey = process.env[provider.credentialEnv]?.trim();
  if (!apiKey)
    return { ...base, status: 'skipped', error: 'Assessment provider is not configured' };
  if (request.signal?.aborted) return { ...base, status: 'skipped', error: 'Assessment cancelled' };
  const timeoutMs = request.timeoutMs ?? config.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error('Invalid assessment timeout');
  if (!/^[\w.-]{1,100}$/.test(model)) throw new Error('Invalid assessment model');
  let input;
  try {
    input = prepareAssessmentInput(request.state, request.questions, config.maxStateBytes, apiKey);
  } catch (error) {
    return {
      ...base,
      status: 'skipped',
      error: error instanceof Error ? error.message : 'Assessment input rejected',
    };
  }
  const preparedIdentity = {
    stateHash: hash(input.state),
    questionSchemaHash: hash(input.questions),
  };
  if (Object.values(input.questions).some((q) => !provider.capabilities.includes(q.type)))
    return {
      ...base,
      status: 'skipped',
      error: 'Provider does not support the requested question type',
    };
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(request.signal ? [request.signal] : []),
  ]);
  try {
    const response = await provider.assess({ ...input, model, apiKey, signal });
    return {
      ...base,
      ...preparedIdentity,
      status: 'completed',
      attempted: true,
      returnedModel: response.returnedModel,
      answers: response.answers,
      usage: {
        ...response.usage,
        provider: provider.id,
        requestedModel: model,
        returnedModel: response.returnedModel,
      },
    };
  } catch (error) {
    // Optional provider failures leave the workflow intact. Never persist upstream
    // exception text: SDK/network errors can include credentials or input excerpts.
    return {
      ...base,
      status: 'unavailable',
      attempted: error instanceof AssessmentResponseError ? error.attempted : true,
      ...(error instanceof AssessmentResponseError && error.usage
        ? {
            returnedModel: error.returnedModel,
            usage: {
              ...error.usage,
              provider: provider.id,
              requestedModel: model,
              returnedModel: error.returnedModel,
            },
          }
        : {}),
      ...preparedIdentity,
      error:
        error instanceof AssessmentResponseError && error.responseReceived
          ? ASSESSMENT_RESPONSE_VALIDATION_ERROR
          : signal.aborted
            ? 'Assessment cancelled or timed out'
            : 'Assessment provider request failed',
    };
  }
}
