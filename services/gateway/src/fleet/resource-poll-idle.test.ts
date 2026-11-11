import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import '../runtime/mock-pty.test-support.js';

const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    resolveSlot: async () => ({ pool: { project: 'fixture-project' }, slot: {} }),
    loadProjectVars: async () => ({ projectJson: {} }),
  },
});
const state = await import('../core/state.js');
mock.module('../core/state.js', {
  namedExports: {
    ...state,
    readSlotRow: async (slotId: string) => ({
      current_run_id: slotId === 'slot-a' ? 'run-a' : null,
      slot_epoch: 1,
    }),
  },
});
let polls = 0;
const fleet = await import('./state.js');
mock.module('./state.js', {
  namedExports: {
    ...fleet,
    loadFleetStatus: async () => {
      polls++;
      return { slots: [{ slot: 'slot-a' }] };
    },
  },
});
const modulePath = './resource-manager.js?resource-poll-idle';
const { startResourcePolling, stopResourcePolling }: typeof import('./resource-manager.js') =
  await import(modulePath);
const { withRunTransitionWhileMachineHeld } =
  await import('../run-lifecycle/transition-coordinator.js');

test(
  'a long run transition does not hold pollAllInFlight across fleet poll ticks',
  { timeout: 2_000 },
  async (t) => {
    let tick: () => unknown = () => assert.fail('poll callback not installed');
    const timer = setInterval(() => {}, 60_000);
    timer.unref();
    t.mock.method(globalThis, 'setInterval', (callback: () => unknown) => {
      tick = callback;
      return timer;
    });
    t.mock.method(globalThis, 'setTimeout', () => timer);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transition = withRunTransitionWhileMachineHeld('run-a', async () => {
      enter();
      await held;
    });
    await entered;
    try {
      startResourcePolling(() => {});
      await tick();
      await tick();
      assert.equal(polls, 2, 'the second fleet poll runs while the transition is still held');
    } finally {
      stopResourcePolling();
      release();
      await transition;
      clearInterval(timer);
    }
  },
);
