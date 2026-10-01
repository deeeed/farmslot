import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { RunTicketData } from '@farmslot/protocol';

let capturedSignal: AbortSignal | undefined;
let neverRespond = false;
let capturedCliFallback: boolean | undefined;
mock.module('../llm/index.js', {
  namedExports: {
    callLLM: async (options: { signal?: AbortSignal; allowCliFallback?: boolean }) => {
      capturedSignal = options.signal;
      capturedCliFallback = options.allowCliFallback;
      if (neverRespond) return new Promise(() => {});
      return {
        text: JSON.stringify({
          difficulty: 'low',
          rationale: 'A specified copy correction.',
          modelRecommendation: 'opus',
          score: 2,
        }),
        usage: { provider: 'fixture', model: 'fixture', durationMs: 1 },
      };
    },
  },
});

const { gradeTicket } = await import('./engine.js');
const ticket = {
  source: 'jira',
  title: 'Correct warning copy',
  description: 'Use the specified warning for both order directions.',
  acceptanceCriteria: [],
  stepsToReproduce: [],
  affectedArea: '',
  screenshots: [],
  labels: [],
} as RunTicketData;

test('grading retains a timely structured provider response', async () => {
  neverRespond = false;
  const result = await gradeTicket(ticket);
  assert.equal(result.grade.difficulty, 'low');
  assert.equal(result.grade.score, 2);
  assert.equal(result.grade.modelRecommendation, 'opus');
  assert.equal(capturedSignal?.aborted, false);
  assert.equal(capturedCliFallback, false);
});

test('grading aborts and rejects after its deadline even if the provider never settles', async (t) => {
  neverRespond = true;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = gradeTicket(ticket);
  const rejection = assert.rejects(result, /ticket grading timed out after 30000ms/);
  t.mock.timers.tick(29_999);
  assert.equal(capturedSignal?.aborted, false);
  t.mock.timers.tick(1);
  await rejection;
  assert.equal(capturedSignal?.aborted, true);
});
