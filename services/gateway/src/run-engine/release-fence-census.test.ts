import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import { makeRun } from '../methods/run/test-fixtures.js';

const live = new Map<string, Run>();
const probed: Array<string | undefined> = [];
let duringCensus = async (): Promise<void> => {};
const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: { ...store, getRun: (id: string) => live.get(id) },
});
const teardown = await import('../run-lifecycle/slot-teardown.js');
mock.module('../run-lifecycle/slot-teardown.js', {
  namedExports: {
    ...teardown,
    slotTeardownBlocker: async (run: Run, options: { inspectReleaseFence?: true }) => {
      assert.equal(options.inspectReleaseFence, true, 'the census is read-only');
      probed.push(run.slotId);
      await duringCensus();
      probed.push(run.slotId);
      return null;
    },
  },
});
const { releaseFenceCensus } = await import('./release-fence-census.js');

test('the census stays on the fenced slot while the live run is rebound mid-census', async () => {
  const run = makeRun({ id: 'census-owner', status: 'done', slotId: 'slot-a' });
  live.set(run.id, run);
  duringCensus = async () => {
    run.slotId = 'slot-b'; // a find-slot activation, rolled back below
    await Promise.resolve();
    run.slotId = 'slot-a';
  };
  assert.equal(await releaseFenceCensus(run, 'slot-a'), null);
  assert.deepEqual(probed, ['slot-a', 'slot-a']);
});

test('a run no longer bound to the fenced slot is refused before any probe', async () => {
  probed.length = 0;
  const run = makeRun({ id: 'moved-owner', status: 'done', slotId: 'slot-b' });
  live.set(run.id, run);
  assert.match(String(await releaseFenceCensus(run, 'slot-a')), /no longer bound to slot-a/);
  assert.deepEqual(probed, []);
});
