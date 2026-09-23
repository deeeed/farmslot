import { APIError, choice, noul, type Questions, score, TypeSafeClient } from '@typesafe-ai/sdk';

import type { AssessmentAnswer, AssessmentQuestion, AssessmentQuestions } from '@farmslot/protocol';

import { type AssessmentProvider, AssessmentResponseError } from './provider.js';

function toQuestions(questions: AssessmentQuestions): Questions {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      if (question.type === 'boolean') return [id, noul(question.instructions)];
      if (question.type === 'choice') return [id, choice(question.instructions, question.criteria)];
      return [id, score(question.instructions, question.criteria as [string, string, ...string[]])];
    }),
  );
}

function normalizeAnswer(question: AssessmentQuestion, raw: unknown): AssessmentAnswer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('provider returned an invalid answer object');
  const value = raw as Record<string, unknown>;
  if (question.type === 'choice') {
    if (value.type !== 'choice' || typeof value.choice !== 'string')
      throw new Error('provider returned an invalid choice answer');
    if (!Object.hasOwn(question.criteria, value.choice))
      throw new Error('provider returned an unknown choice');
    return {
      type: 'choice',
      choice: value.choice,
      probabilities: normalizeProbabilities(value.probabilities, Object.keys(question.criteria)),
      confidence: finiteProbability(value.confidence, 'confidence'),
    };
  }
  if (question.type === 'score') {
    if (
      value.type !== 'score' ||
      typeof value.score !== 'number' ||
      !Number.isFinite(value.score) ||
      value.score < 0 ||
      value.score > question.criteria.length - 1
    )
      throw new Error('provider returned an invalid score answer');
    return {
      type: 'score',
      score: value.score,
      probabilities: normalizeProbabilities(
        value.probabilities,
        question.criteria.map((_, index) => String(index)),
      ),
      confidence: finiteProbability(value.confidence, 'confidence'),
      legend: Object.fromEntries(
        question.criteria.map((criterion, index) => [String(index), criterion]),
      ),
    };
  }
  if (value.type !== 'noul') throw new Error('provider returned an invalid boolean answer');
  return { type: 'boolean', probability: finiteProbability(value.noul, 'boolean probability') };
}

function finiteProbability(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error(`provider returned invalid ${label}`);
  return value;
}
function normalizeProbabilities(raw: unknown, expected: string[]): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('provider returned invalid probabilities');
  const value = raw as Record<string, unknown>;
  return Object.fromEntries(
    expected.map((key) => [key, finiteProbability(value[key], `probability for ${key}`)]),
  );
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const token = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const identity = (value: unknown, apiKey: string) =>
  typeof value === 'string' && /^[\w.-]{1,200}$/.test(value) && !value.includes(apiKey)
    ? value
    : undefined;
const httpStatus = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;

function responseReceipt(response: Response, apiKey: string, started: number) {
  const safeRequestId = identity(response.headers.get('x-typesafe-request-id'), apiKey);
  return {
    usage: {
      durationMs: Date.now() - started,
      ...(safeRequestId === undefined ? {} : { requestId: safeRequestId }),
    },
    httpStatus: httpStatus(response.status),
  };
}

function receipt(value: unknown, requestId: unknown, apiKey: string, started: number) {
  const body = object(value) ? value : {};
  const rawUsage = object(body.usage) ? body.usage : undefined;
  const inputTokens = token(rawUsage?.input_tokens);
  const outputTokens = token(rawUsage?.output_tokens);
  const safeRequestId = identity(requestId, apiKey);
  return {
    returnedModel: identity(body.model, apiKey),
    hasValidInputUsage: rawUsage?.input_tokens !== undefined && inputTokens !== undefined,
    hasValidOutputUsage: rawUsage?.output_tokens === undefined || outputTokens !== undefined,
    usage: {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      durationMs: Date.now() - started,
      ...(safeRequestId === undefined ? {} : { requestId: safeRequestId }),
    },
  };
}

export function createTypeSafeProvider(fetchImpl?: typeof fetch): AssessmentProvider {
  return {
    id: 'typesafe',
    defaultModel: 'jev-1.13.0',
    credentialEnv: 'TYPESAFE_API_KEY',
    capabilities: ['choice', 'score', 'boolean'],
    async assess({ state, questions, model, signal, apiKey }) {
      const started = Date.now();
      let receivedHttp: ReturnType<typeof responseReceipt> | undefined;
      const transport = fetchImpl ?? fetch;
      const observedFetch: typeof fetch = async (input, init) => {
        const response = await transport(input, init);
        receivedHttp = responseReceipt(response, apiKey, started);
        return response;
      };
      const client = new TypeSafeClient({
        apiKey,
        defaultModel: model,
        timeout: 60_000,
        retry: { maxRetries: 0 },
        logLevel: 'off',
        fetch: observedFetch,
      });
      const sdkState =
        typeof state === 'number' || typeof state === 'boolean' ? String(state) : state;
      const request = client.systemOne(
        { state: sdkState, model, questions: toQuestions(questions) },
        { signal, retry: { maxRetries: 0 } },
      );
      let result: Awaited<ReturnType<typeof request.withResponse>>;
      try {
        result = await request.withResponse();
      } catch (error) {
        if (error instanceof APIError) {
          const received = receipt(error.body, error.requestId, apiKey, started);
          throw new AssessmentResponseError(
            'Assessment provider returned an HTTP error',
            true,
            received.usage,
            received.returnedModel,
            true,
            httpStatus(error.status),
          );
        }
        // The SDK buffers successful bodies before resolving `withResponse()`. Our transport
        // wrapper sees headers first, so a body-read failure or timeout still has a safe receipt.
        if (receivedHttp) {
          throw new AssessmentResponseError(
            'Assessment provider response could not be read',
            true,
            receivedHttp.usage,
            undefined,
            true,
            receivedHttp.httpStatus,
          );
        }
        throw error;
      }
      const received = receipt(result.data, result.requestId, apiKey, started);
      try {
        // Validate answers after capturing safe receipt fields; malformed replies must not
        // escape as provider text or discard known usage.
        const data = result.data;
        if (!received.hasValidInputUsage || !received.hasValidOutputUsage)
          throw new Error('provider returned invalid usage');
        if (received.returnedModel !== model)
          throw new Error('provider returned a different model');
        const answers: Record<string, AssessmentAnswer> = {};
        for (const [id, question] of Object.entries(questions))
          answers[id] = normalizeAnswer(question, data.answers[id]);
        return {
          returnedModel: received.returnedModel,
          answers,
          usage: received.usage,
        };
      } catch {
        // Never propagate response fragments in validation errors.
        throw new AssessmentResponseError(
          'Assessment provider response failed validation',
          true,
          received.usage,
          received.returnedModel,
          true,
        );
      }
    },
  };
}
