import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotStatus } from '@farmslot/protocol';

import type { AppState } from '../../state.js';

import type { SlotView } from './slot-view.js';

let changed: ((state: AppState) => void) | undefined;
mock.module('../../state.js', {
  namedExports: {
    subscribe: (listener: typeof changed) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
  },
});
mock.module('../../gateway-client.js', {
  namedExports: {
    gateway: { subscribe: () => () => {}, onConnectionChange: () => () => {} },
  },
});
mock.module('../shared/slot-prepare-tracker.js', {
  namedExports: { activeSlotPrepare: () => null, subscribeSlotPrepareTracker: () => () => {} },
});
mock.module('./slot-view-layout.js', { namedExports: { loadLayout: () => ({}) } });
mock.module('./slot-view-recipe-runner-effects.js', {
  namedExports: { refreshSlotViewRecipeRunnerOptions: async () => {} },
});
mock.module('./slot-view-resize-effects.js', {
  namedExports: {
    connectSlotViewLayoutObserver: () => {},
    disconnectSlotViewLayoutObserver: () => {},
  },
});
const { connectSlotView, disconnectSlotView } = await import('./slot-view-connection-effects.js');

test('an open slot follows its shared fleet projection without repeating initial side reads', (t) => {
  const globals = ['document', 'window', 'localStorage'] as const;
  const prior = globals.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  let mounted: SlotView | undefined;
  const target = { addEventListener() {}, removeEventListener() {} };
  for (const [key, value] of [
    ['document', target],
    ['window', target],
    ['localStorage', { getItem: () => null }],
  ] as const)
    Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    if (mounted) disconnectSlotView(mounted);
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const original = { slot: 'same-slot', lifecycle: 'manual', currentRunId: null } as SlotStatus;
  let initialLoads = 0;
  let runSyncs = 0;
  const view = {
    slotId: 'same-slot',
    _slot: null as SlotStatus | null,
    _selectedAgentContextIds: {},
    _restoreHistoryFromUrl() {},
    _getHashParam: () => null,
    _loadSlot(this: SlotView) {
      initialLoads++;
      this._slot = original;
    },
    _requestSlotSwitcherUpdate() {},
    _runQueries: {
      sync() {
        runSyncs++;
      },
    },
    _cancelFileRestoreRetry() {},
    _cancelResourceRestoreRetry() {},
    _teardownLive() {},
    _confirmTimer: { clear() {} },
    _copyFeedback: { clear() {} },
  } as unknown as SlotView;
  mounted = view;
  connectSlotView(view);
  const updated = { ...original, lifecycle: 'ready' } as SlotStatus;
  changed!({ fleet: { slots: [updated] } } as AppState);
  assert.equal(view._slot, updated);
  assert.equal(initialLoads, 1);
  assert.equal(runSyncs, 1);
  const rebound = { ...updated, currentRunId: 'next-run' };
  changed!({ fleet: { slots: [rebound] } } as AppState);
  assert.equal(view._slot, rebound);
  assert.equal(runSyncs, 2, 'An owner change must fence linked-run selection immediately');
  changed!({ fleet: { slots: [] } } as unknown as AppState);
  assert.equal(view._slot, null, 'Removed slots must not leave a copied action context');
  assert.equal(runSyncs, 3);
  view._slot = rebound;
  changed!({ fleet: null } as AppState);
  assert.equal(view._slot, null, 'A cleared authority must retire copied slot facts');
  assert.equal(runSyncs, 4);
});
