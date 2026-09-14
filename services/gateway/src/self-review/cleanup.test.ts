import assert from 'node:assert/strict';
import test from 'node:test';

import { finishReviewCleanup } from './cleanup.js';

test('async cleanup failures preserve the primary failure and do not skip subsequent cleanup', async () => {
  const primary = new Error('review failed');
  const close = new Error('watch close failed');
  const status = new Error('status cleanup failed');
  const order: string[] = [];
  await assert.rejects(
    finishReviewCleanup(primary, [
      async () => {
        await Promise.resolve();
        order.push('close');
        throw close;
      },
      () => {
        order.push('status');
        throw status;
      },
      async () => {
        order.push('restore');
      },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.deepEqual(error.errors, [primary, close, status]);
      assert.match(error.message, /review failed; watch close failed; status cleanup failed/);
      return true;
    },
  );
  assert.deepEqual(order, ['close', 'status', 'restore']);
});

test('cleanup failures also fail an otherwise successful review', async () => {
  await assert.rejects(
    finishReviewCleanup(undefined, [
      async () => {
        throw new Error('close failed');
      },
    ]),
    /close failed/,
  );
});
