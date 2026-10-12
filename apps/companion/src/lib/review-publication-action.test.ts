import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods, type Run } from '@farmslot/protocol';

import {
  readReviewRun,
  retryReviewPublication,
} from '../features/workspace-shared/review-publication-action';

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

test('full saved reads reject invalidated authority, superseded requests and another run', async () => {
  let release!: (result: { run: Run }) => void;
  let sequence = 0;
  const accepted: Run[] = [];
  const client = {
    request: () =>
      new Promise<{ run: Run }>((resolve) => {
        release = resolve;
      }),
  } as Pick<GatewayClient, 'request'>;
  const first = ++sequence;
  const read = readReviewRun(
    client,
    'review',
    () => sequence === first,
    (run) => accepted.push(run),
  );
  ++sequence;
  release({ run: { id: 'review' } as Run });
  await read;
  assert.equal(accepted.length, 0);
  const current = readReviewRun(
    client,
    'review',
    () => true,
    (run) => accepted.push(run),
  );
  release({ run: { id: 'other' } as Run });
  await current;
  assert.equal(accepted.length, 0);
  const full = { id: 'review', reviewResult: { reviewMd: 'large'.repeat(1000) } } as Run;
  const successful = readReviewRun(
    client,
    'review',
    () => true,
    (run) => accepted.push(run),
  );
  release({ run: full });
  await successful;
  assert.deepEqual(accepted, [full]);
});
