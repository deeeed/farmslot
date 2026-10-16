import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import '../runtime/mock-pty.test-support.js';

import { makeRun } from '../run-engine/test-fixtures.js';

const run = makeRun({ slotId: 'mixed-review-slot', status: 'reviewing' });
run.transport = 'tmux';
const stopped: string[] = [];
const reachedTmux = new Error('Reached retained tmux worker cleanup');
const core = await import('../core/index.js');
mock.module('../core/index.js', {
  namedExports: {
    ...core,
    readSlotRow: async () => ({ slot: run.slotId, current_run_id: run.id }),
    updateSlotStatusIf: async () => false,
  },
});
const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: { ...store, getRun: (id: string) => (id === run.id ? run : undefined) },
});
const workers = await import('../runners/native/worker.js');
mock.module('../runners/native/worker.js', {
  namedExports: {
    ...workers,
    cancelNativeRunWorkers: async (id: string) => {
      stopped.push(id);
    },
  },
});
const teardown = await import('./slot-teardown.js');
mock.module('./slot-teardown.js', {
  namedExports: {
    ...teardown,
    stopRunOwnedTmuxAndWatches: async () => {
      throw reachedTmux;
    },
  },
});
// Core's existing cycles can preload these callers before the module mocks.
// Fresh module instances exercise their real branch logic against the test ports.
const cancel: typeof import('./cancel-transition.js') = await import(
  new URL('./cancel-transition.js?mixed-review-cleanup', import.meta.url).href
);
const lifecycle: typeof import('../methods/run/lifecycle-control.js') = await import(
  new URL('../methods/run/lifecycle-control.js?mixed-review-cleanup', import.meta.url).href
);

test('cancel and completed release retire native reviewer leases before stopping a tmux worker', async () => {
  const before = structuredClone(run);
  await assert.rejects(
    cancel.defaultCancelCollaborators().releaseCapabilities(run),
    (error) => error === reachedTmux,
  );
  assert.deepEqual(stopped, [run.id]);
  await assert.rejects(lifecycle.releaseCompletedRunSlot(run), (error) => error === reachedTmux);
  assert.deepEqual(stopped, [run.id, run.id]);
  assert.deepEqual(run, before);
});
