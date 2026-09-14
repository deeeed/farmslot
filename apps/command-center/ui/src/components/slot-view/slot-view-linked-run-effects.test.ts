import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import type { SlotView } from './slot-view.js';

const requests: Array<{
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}> = [];
let cachedRun: Run | null = null;
let contextId = 'unknown';
mock.module('../../gateway-client.js', {
  namedExports: {
    gateway: {
      connectionState: 'connected',
      request: (method: string) =>
        new Promise((resolve, reject) => requests.push({ method, resolve, reject })),
    },
  },
});
mock.module('../../state.js', {
  namedExports: { getRunForSlot: () => cachedRun, getState: () => ({ fleet: { slots: [] } }) },
});
mock.module('../../utils/reconnect.js', {
  namedExports: { isRecoveryEpochCurrent: () => false },
});
mock.module('./slot-view-live-effects.js', {
  namedExports: { loadSlotViewGitFileContent: () => Promise.resolve() },
});
mock.module('./slot-view-url-state.js', {
  namedExports: { requestedRunFromHash: () => 'active', getSlotViewHashParam: () => contextId },
});
const { applySlotViewLinkedRun, refreshSlotViewLinkedRun } =
  await import('./slot-view-linked-run-effects.js');

function nativeRun(): Run {
  return {
    id: 'active',
    slotId: 'slot',
    transport: 'native',
    status: 'running',
    steps: [],
    decisions: [],
    agentContexts: [
      {
        id: 'dev',
        role: 'dev',
        label: 'Dev',
        runId: 'active',
        slotId: 'slot',
        target: null,
        nativeSession: { sessionId: 'session', leaseId: 'lease' },
      },
    ],
  } as unknown as Run;
}
function mountedView(run: Run): SlotView {
  return {
    slotId: 'slot',
    _linkedRun: run,
    _lastLinkedRunId: run.id,
    _isLive: true,
    _refreshRecipeRuns: () => Promise.resolve(),
  } as unknown as SlotView;
}

test('cache hydration cannot retain a mounted native run under an unknown same-run context', () => {
  const run = nativeRun();
  const view = mountedView(run);
  contextId = 'dev';
  assert.equal(applySlotViewLinkedRun(view, null, 'running', 'cache'), 'running');
  assert.equal(view._linkedRun, run);
  contextId = 'unknown';
  assert.equal(applySlotViewLinkedRun(view, null, 'running', 'cache'), null);
  assert.equal(view._linkedRun, null);
  assert.equal(view._lastLinkedRunId, null);
});

test('cached and direct native publication stays cleared while slot lookup waits and fails', async () => {
  cachedRun = nativeRun();
  const view = mountedView(cachedRun);
  const refresh = refreshSlotViewLinkedRun(view, 'running');
  assert.equal(view._linkedRun, null, 'cache must validate before publishing');
  const direct = requests.shift();
  assert.equal(direct?.method, 'run.get');
  direct?.resolve({ run: cachedRun });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view._linkedRun, null, 'direct hydration must validate before publishing');
  const slot = requests.shift();
  assert.equal(slot?.method, 'run.forSlot');
  slot?.reject(new Error('slot lookup unavailable'));
  await refresh;
  assert.equal(view._linkedRun, null, 'slot failure must not leave a fallback mounted');
});
