import { choice, noul, type Questions, score, TypeSafeClient } from '@typesafe-ai/sdk';

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

export function createTypeSafeProvider(fetchImpl?: typeof fetch): AssessmentProvider {
  return {
    id: 'typesafe',
    defaultModel: 'jev-1.13.0',
    credentialEnv: 'TYPESAFE_API_KEY',
    capabilities: ['choice', 'score', 'boolean'],
    async assess({ state, questions, model, signal, apiKey }) {
      const started = Date.now();
      const client = new TypeSafeClient({
        apiKey,
        defaultModel: model,
        timeout: 60_000,
        retry: { maxRetries: 0 },
        logLevel: 'off',
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
      const sdkState =
        typeof state === 'number' || typeof state === 'boolean' ? String(state) : state;
      const result = await client
        .systemOne(
          { state: sdkState, model, questions: toQuestions(questions) },
          { signal, retry: { maxRetries: 0 } },
        )
        .withResponse();
      try {
        const answers: Record<string, AssessmentAnswer> = {};
        for (const [id, question] of Object.entries(questions))
          answers[id] = normalizeAnswer(question, result.data.answers[id]);
        return {
          returnedModel: result.data.model,
          answers,
          usage: {
            inputTokens: result.data.usage.input_tokens,
            outputTokens: result.data.usage.output_tokens,
            durationMs: Date.now() - started,
            requestId: result.requestId,
          },
        };
      } catch {
        // Never propagate response fragments in validation errors.
        throw new AssessmentResponseError('Assessment provider response failed validation');
      }
    },
  };
}
