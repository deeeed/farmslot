import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getQueueSnapshot } from '../backlog/dispatch-queue.js';
import { getCachedFleet } from '../fleet/state.js';
import { getAllRuns } from '../runs/store.js';

import { testController } from './test-helpers.js';

function controlPlaneSnapshot() {
  const fleet = getCachedFleet();
  return {
    activeRuns: getAllRuns().map((run) => ({ id: run.id, slotId: run.slotId, status: run.status })),
    slots: (fleet?.slots ?? []).map((slot) => ({
      slot: slot.slot,
      lifecycle: slot.lifecycle,
      currentRunId: slot.currentRunId,
    })),
    dispatchQueue: getQueueSnapshot().map((item) => ({ id: item.id, status: item.status })),
  };
}

test('all Co-Pilot lifecycle and transport operations are isolated from runs, slots, and queues', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-isolation-'));
  const { controller, tmux } = testController({ home, checkout: process.cwd() });
  const before = controlPlaneSnapshot();

  await controller.status();
  await controller.start({ runner: 'cursor', model: 'test-model' });
  await controller.send({ sessionId: 'global', message: 'inspect only' });
  await controller.abort();
  await controller.start({ mode: 'reconnect' });
  await controller.stop({ reason: 'isolation-test' });

  assert.deepEqual(controlPlaneSnapshot(), before);
  assert.equal(tmux.launchCount, 1);
});
