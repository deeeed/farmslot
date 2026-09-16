import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods, type Run } from '@farmslot/protocol';

import { retryReviewPublication } from '../features/workspace-shared/review-publication-action';

import type { GatewayClient } from './gateway-client';

test('publication retry discards replies after authority or selected run changes', async () => {
  for (const invalidateAt of [0, 1, 2, 3]) {
    const methods: string[] = [];
    const accepted: Run[] = [];
    let current = invalidateAt !== 0;
    const run = { id: 'review' } as Run;
    const client = {
      request: async (method: string, params: unknown) => {
        methods.push(method);
        assert.deepEqual(params, { runId: 'review' });
        if (methods.length === invalidateAt) current = false;
        return method === Methods.RUN_GET ? { run } : { receipt: { state: 'published' } };
      },
    } as Pick<GatewayClient, 'request'>;
    await retryReviewPublication(
      client,
      'review',
      () => current,
      (value) => accepted.push(value),
    );
    assert.equal(methods.length, Math.min(invalidateAt, 2));
    assert.deepEqual(accepted, invalidateAt === 3 ? [run] : []);
  }
});

test('publication failures propagate without fetching or accepting a run', async () => {
  const calls: string[] = [];
  const client = {
    request: async (method: string) => {
      calls.push(method);
      throw new Error('Policy revoked');
    },
  } as Pick<GatewayClient, 'request'>;
  await assert.rejects(
    retryReviewPublication(
      client,
      'review',
      () => true,
      () => assert.fail('Unexpected adoption'),
    ),
    /Policy revoked/,
  );
  assert.deepEqual(calls, [Methods.PR_REVIEW_PUBLISH]);
});
