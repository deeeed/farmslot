import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods } from '@farmslot/protocol';

import { type ExtendableGate, requestAnotherReviewRound } from './review-budget';

const gate: ExtendableGate = {
  id: 'gate-1',
  payload: { kind: 'ready', reviewRoundBudget: { limit: 3 }, prPackage: { headSha: 'abc123' } },
};

test('one more review round asks the gateway to raise this gate limit by one', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  await requestAnotherReviewRound(
    {
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        return undefined as T;
      },
    },
    'run-1',
    gate,
    'the open findings',
  );
  assert.deepEqual(calls, [
    {
      method: Methods.RUN_EXTEND_REVIEW_BUDGET,
      params: {
        runId: 'run-1',
        requestId: 'extend-review-budget:gate-1:3',
        expectedLimit: 3,
        limit: 4,
        headSha: 'abc123',
        scopeBrief: 'the open findings',
      },
    },
  ]);
});

test('a gate without a budget or package head cannot be extended', () => {
  assert.throws(
    () =>
      requestAnotherReviewRound(
        { request: async <T>(): Promise<T> => undefined as T },
        'run-1',
        { ...gate, payload: null },
        'brief',
      ),
    /no review budget or package head/,
  );
});
