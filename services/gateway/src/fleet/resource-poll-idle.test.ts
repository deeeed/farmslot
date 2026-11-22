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
      return { slots: [{ slot: 'slot-a' }, { slot: 'slot-b' }, { slot: 'slot-c' }] };
    },
  },
});
const idle = await import('../run-lifecycle/idle-devserver-service.js');
const swept: string[] = [];
mock.module('../run-lifecycle/idle-devserver-service.js', {
  namedExports: {
    ...idle,
    reapIdleDevServers: async (slotId: string) => {
      swept.push(slotId);
      if (slotId === 'slot-a') await idle.reapIdleDevServers(slotId);
    },
  },
});
const modulePath = './resource-manager.js?resource-poll-idle';
const {
  setCachedResourceStatus,
  startIdleDevServerSweep,
  stopIdleDevServerSweep,
}: typeof import('./resource-manager.js') = await import(modulePath);
const { withRunTransitionWhileMachineHeld } =
  await import('../run-lifecycle/transition-coordinator.js');

function captureTick(t: { mock: typeof mock }): { tick: () => unknown; timer: NodeJS.Timeout } {
  const captured = { tick: (): unknown => assert.fail('sweep callback not installed') };
  const timer = setInterval(() => {}, 60_000);
  timer.unref();
  t.mock.method(globalThis, 'setInterval', (callback: () => unknown) => {
    captured.tick = callback;
    return timer;
  });
  return {
    get tick() {
      return captured.tick;
    },
    timer,
  };
}

test('the idle dev-server sweep runs without full-fleet polling, on slots with live resources', async (t) => {
  setCachedResourceStatus('slot-a', 'dev-server', 'running', { broadcast: false });
  setCachedResourceStatus('slot-b', 'browser', 'stopped', { broadcast: false });
  setCachedResourceStatus('slot-c', 'dev-server', 'stale', { broadcast: false });
  const clock = captureTick(t);
  swept.length = 0;
  try {
    startIdleDevServerSweep();
    await clock.tick();
    assert.deepEqual(swept, ['slot-a', 'slot-c']);
  } finally {
    stopIdleDevServerSweep();
    clearInterval(clock.timer);
  }
});

test(
  'a long run transition does not hold the idle sweep across ticks, and the skip is logged once',
  { timeout: 2_000 },
  async (t) => {
    const clock = captureTick(t);
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
    const info = t.mock.method(console, 'info', () => {});
    const before = polls;
    try {
      startIdleDevServerSweep();
      await clock.tick();
      await clock.tick();
      assert.equal(polls - before, 2, 'the second sweep runs while the transition is still held');
      assert.deepEqual(
        info.mock.calls.map((call) => call.arguments[0]),
        ['[idle-devserver] slot=slot-a resource=- decision=skip: run transition in progress'],
      );
    } finally {
      stopIdleDevServerSweep();
      release();
      await transition;
      clearInterval(clock.timer);
    }
  },
);
