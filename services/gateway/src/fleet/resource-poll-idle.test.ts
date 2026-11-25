import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import '../runtime/mock-pty.test-support.js';

const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    resolveSlot: async () => ({
      pool: { project: 'fixture-project' },
      slot: { resources: { server: {} } },
    }),
    loadProjectVars: async () => ({
      projectJson: {
        resources: {
          server: {
            type: 'dev-server',
            hooks: { boot: 'boot', health: 'health' },
            watch: { type: 'port-listen', port: 9300 },
          },
        },
      },
    }),
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
let fleetSlots = ['slot-a', 'slot-b', 'slot-c'];
let hold: Promise<void> | undefined;
const fleet = await import('./state.js');
mock.module('./state.js', {
  namedExports: {
    ...fleet,
    loadFleetStatus: async () => {
      polls++;
      return { slots: fleetSlots.map((slot) => ({ slot })) };
    },
  },
});
const idle = await import('../run-lifecycle/idle-devserver-service.js');
const swept: string[] = [];
const forgotten: string[] = [];
const scopePasses: string[][] = [];
mock.module('../run-lifecycle/idle-devserver-service.js', {
  namedExports: {
    ...idle,
    reapIdleDevServers: async (slotId: string) => {
      swept.push(slotId);
      await hold;
      if (slotId === 'slot-a') await idle.reapIdleDevServers(slotId);
    },
    forgetIdleDevServers: (slotId: string) => forgotten.push(slotId),
    reapIdlePrepareScopes: async (slots: Array<{ slot: string }>) => {
      scopePasses.push(slots.map((slot) => slot.slot));
    },
  },
});
const modulePath = './resource-manager.js?resource-poll-idle';
const {
  resourceObservationLosses,
  setCachedResourceStatus,
  startIdleDevServerSweep,
  stopIdleDevServerSweep,
}: typeof import('./resource-manager.js') = await import(modulePath);
const shared = await import('./resource-manager.js');
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
  t.mock.method(console, 'info', () => {});
  setCachedResourceStatus('slot-a', 'server', 'stopped', { broadcast: false });
  setCachedResourceStatus('slot-b', 'browser', 'stopped', { broadcast: false });
  setCachedResourceStatus('slot-c', 'server', 'stale', { broadcast: false });
  const clock = captureTick(t);
  swept.length = 0;
  forgotten.length = 0;
  scopePasses.length = 0;
  try {
    startIdleDevServerSweep();
    await clock.tick();
    assert.deepEqual(swept, ['slot-c']);
    assert.deepEqual(forgotten, ['slot-a', 'slot-b'], 'unobserved slots lose their idle windows');
    // One scope pass per sweep, offered every slot: a live simulator or browser must not hide one.
    assert.deepEqual(scopePasses, [['slot-a', 'slot-b', 'slot-c']]);
    const lost = resourceObservationLosses('slot-c', 'server');
    setCachedResourceStatus('slot-c', 'server', 'unknown', { broadcast: false });
    setCachedResourceStatus('slot-c', 'server', 'running', { broadcast: false });
    assert.equal(resourceObservationLosses('slot-c', 'server'), lost + 1);
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
    // The sweep reads this module copy; the reaper reads the shared one.
    setCachedResourceStatus('slot-a', 'server', 'running', { broadcast: false });
    shared.setCachedResourceStatus('slot-a', 'server', 'running', { broadcast: false });
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

test('a stopped sweep starts no queued slot', async (t) => {
  t.mock.method(console, 'info', () => {});
  const ids = ['q-1', 'q-2', 'q-3', 'q-4', 'q-5'];
  for (const id of ids) setCachedResourceStatus(id, 'server', 'running', { broadcast: false });
  fleetSlots = ids;
  let release!: () => void;
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const clock = captureTick(t);
  swept.length = 0;
  try {
    startIdleDevServerSweep();
    const sweep = clock.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(swept, ['q-1', 'q-2', 'q-3', 'q-4'], 'four slots run at once');
    stopIdleDevServerSweep();
    release();
    await sweep;
    assert.deepEqual(swept, ['q-1', 'q-2', 'q-3', 'q-4'], 'the fifth never starts');
  } finally {
    stopIdleDevServerSweep();
    hold = undefined;
    fleetSlots = ['slot-a', 'slot-b', 'slot-c'];
    clearInterval(clock.timer);
  }
});
