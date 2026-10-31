import assert from 'node:assert/strict';
import test from 'node:test';

import { EVAL_WORKER_BLOCKED_OUTPUT, evalWorkerBlockedReason } from './blocked-first-output.js';

test('only the monitor step names why a blind eval worker blocked itself', () => {
  const monitor = (outputs: Record<string, unknown>) => ({
    steps: [{ name: 'monitor' as const, status: 'done' as const, outputs }],
  });
  assert.equal(
    evalWorkerBlockedReason(monitor({ [EVAL_WORKER_BLOCKED_OUTPUT]: 'No recipe proof' })),
    'No recipe proof',
  );
  assert.equal(evalWorkerBlockedReason(monitor({ [EVAL_WORKER_BLOCKED_OUTPUT]: true })), undefined);
  assert.equal(evalWorkerBlockedReason(monitor({})), undefined);
  assert.equal(
    evalWorkerBlockedReason({
      steps: [{ name: 'review', status: 'done', outputs: { [EVAL_WORKER_BLOCKED_OUTPUT]: 'x' } }],
    }),
    undefined,
  );
});
