import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const store = await import('../runs/store.js');
const run = store.buildRunRecord({
  flowType: 'dev',
  project: 'fixture',
  ticketOrPr: 'fixture',
  mode: 'autonomous',
});
mock.module('../runs/store.js', { namedExports: { ...store, getRun: () => run } });
const replay = await import('./eval-replay-normalization.js');
mock.module('./eval-replay-normalization.js', {
  namedExports: { ...replay, normalizeEvalReplayForTaskWrite: async () => run },
});
let checks = 0;
const catalog = await import('../host-services/node-pack-template.js');
mock.module('../host-services/node-pack-template.js', {
  namedExports: {
    ...catalog,
    ensureRunNodePackTemplate: async () => {
      checks++;
      throw new Error('node pack fixture at old, gateway at current');
    },
  },
});
const { executeWriteTaskStep } = await import('./task-steps.js');

test('still-stale admission refuses before creating task output or preparing a checkout', async () => {
  const original = structuredClone(run);
  const partial = new Map();
  await assert.rejects(
    executeWriteTaskStep(run.id, run, { broadcastFn: () => undefined, stepPartialIO: partial }),
    /node pack fixture at old, gateway at current/,
  );
  assert.equal(checks, 1);
  assert.deepEqual(run, original);
  assert.equal(partial.size, 0);
});
