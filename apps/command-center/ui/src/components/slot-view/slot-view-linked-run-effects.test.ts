import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import type { SlotView } from './slot-view.js';

let contextId = 'unknown';
mock.module('../../utils/reconnect.js', {
  namedExports: { isRecoveryEpochCurrent: () => false },
});
mock.module('./slot-view-live-effects.js', {
  namedExports: { loadSlotViewGitFileContent: () => Promise.resolve() },
});
mock.module('./slot-view-url-state.js', {
  namedExports: { requestedRunFromHash: () => 'active', getSlotViewHashParam: () => contextId },
});
const { applySlotViewLinkedRun } = await import('./slot-view-linked-run-effects.js');

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
