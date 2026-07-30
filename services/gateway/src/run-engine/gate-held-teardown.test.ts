import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { PipelineSteps } from '@farmslot/protocol';

const killed: string[] = [];

mock.module('../methods/slot/release.js', {
  namedExports: {
    killSlotAgents: async (slotId: string) => {
      killed.push(slotId);
    },
  },
});

const { teardownGateHeldAgentsIfNeeded } = await import('./gate-held-lifecycle.js');
const { makeRun } = await import('./test-fixtures.js');

test('teardownGateHeldAgentsIfNeeded kills agents only on terminal failure after gate-held FINALIZE', async () => {
  const warmThroughCi = makeRun({
    flowType: 'dev',
    mode: 'autonomous',
    slotId: 'macwork-mm-4',
    status: 'ci-watching',
  });
  warmThroughCi.steps = [
    { name: PipelineSteps.COMPLETE, status: 'done', outputs: { slotDisposition: 'gate-held' } },
    { name: PipelineSteps.FINALIZE, status: 'done' },
  ];
  await teardownGateHeldAgentsIfNeeded(warmThroughCi);
  assert.deepEqual(killed, [], 'successful finalize must keep the worker warm for ci-watch');

  killed.length = 0;
  const failedAfterFinalize = makeRun({
    flowType: 'dev',
    mode: 'autonomous',
    slotId: 'macwork-mm-4',
    status: 'failed',
  });
  failedAfterFinalize.steps = [
    { name: PipelineSteps.COMPLETE, status: 'done', outputs: { slotDisposition: 'gate-held' } },
    { name: PipelineSteps.FINALIZE, status: 'done' },
  ];
  await teardownGateHeldAgentsIfNeeded(failedAfterFinalize);
  assert.deepEqual(killed, ['macwork-mm-4']);

  killed.length = 0;
  const failedAtGate = makeRun({
    flowType: 'dev',
    mode: 'autonomous',
    slotId: 'macwork-mm-4',
    status: 'failed',
  });
  failedAtGate.steps = [
    { name: PipelineSteps.COMPLETE, status: 'done', outputs: { slotDisposition: 'gate-held' } },
    { name: PipelineSteps.HUMAN_GATE, status: 'failed' },
  ];
  await teardownGateHeldAgentsIfNeeded(failedAtGate);
  assert.deepEqual(killed, []);

  await teardownGateHeldAgentsIfNeeded(makeRun({ flowType: 'dev', mode: 'autonomous' }));
  assert.deepEqual(killed, []);
});
