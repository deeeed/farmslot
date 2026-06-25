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

test('teardownGateHeldAgentsIfNeeded kills agents only for gate-held runs with a slot', async () => {
  const run = makeRun({ flowType: 'dev', mode: 'autonomous', slotId: 'macwork-mm-4' });
  run.steps = [
    { name: PipelineSteps.COMPLETE, status: 'done', outputs: { slotDisposition: 'gate-held' } },
  ];
  await teardownGateHeldAgentsIfNeeded(run);
  assert.deepEqual(killed, ['macwork-mm-4']);

  killed.length = 0;
  await teardownGateHeldAgentsIfNeeded(makeRun({ flowType: 'dev', mode: 'autonomous' }));
  assert.deepEqual(killed, []);
});