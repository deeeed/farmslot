import assert from 'node:assert/strict';
import test from 'node:test';

import { SUPERSEDED_READ_GRACE_MS } from '@farmslot/protocol/client-cache';

import { mountHook } from '../hooks/hook-harness.fixtures';

import { createHeldConnection, createOfflineClock, RECONNECT_GRACE_MS } from './held-connection';

const connected = { status: 'connected', client: { connectionState: 'connected' as const } };
const reconnecting = { status: 'connecting', client: { connectionState: 'connecting' as const } };

test('a short reconnect still counts as connected for held data; an outage does not', () => {
  assert.equal(RECONNECT_GRACE_MS, SUPERSEDED_READ_GRACE_MS, 'One shared threshold');
  const clock = createOfflineClock(0);
  assert.equal(clock.held(connected, 1_000), true);
  assert.equal(clock.held(reconnecting, 2_000), true, 'The drop starts the grace');
  assert.equal(clock.held(reconnecting, 2_000 + RECONNECT_GRACE_MS - 1), true);
  assert.equal(clock.held(reconnecting, 2_000 + RECONNECT_GRACE_MS), false, 'Past the grace');
  assert.equal(clock.held(connected, 70_000), true, 'Reconnecting resets it');
  // The store status alone is not enough: the transport must be connected too.
  assert.equal(clock.held({ ...connected, client: reconnecting.client }, 80_000), true);
  assert.equal(
    clock.held({ ...connected, client: reconnecting.client }, 80_000 + RECONNECT_GRACE_MS),
    false,
  );
  // A cold start counts from launch.
  assert.equal(createOfflineClock(0).held(reconnecting, RECONNECT_GRACE_MS), false);
});

test('a flag shows only once it has held for the grace', () => {
  const timers: Array<() => void> = [];
  let now = 1_000;
  const hook = mountHook<[boolean, number]>(
    new URL('./held-connection.ts', import.meta.url),
    'usePersistentFlag',
    { '@farmslot/protocol/client-cache': { SUPERSEDED_READ_GRACE_MS } },
    {
      Date: { now: () => now },
      setTimeout: (callback: () => void) => timers.push(callback),
      clearTimeout: () => undefined,
    },
  );
  try {
    assert.equal(hook.render(true, 60_000), false, 'A brief condition never shows');
    now += 59_999;
    assert.equal(hook.render(true, 60_000), false);
    assert.equal(hook.render(false, 60_000), false, 'Clearing restarts the wait');
    assert.equal(hook.render(true, 60_000), false);
    now += 60_000;
    assert.equal(hook.render(true, 60_000), true, 'A persistent condition shows');
  } finally {
    hook.cleanup();
  }
});

// GatewayClient disconnects while the app is in the background; coming back is not an outage.
test('a return from the background gets the full grace, not an outage', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const paused = { status: 'disconnected', client: { connectionState: 'disconnected' as const } };
  type State = typeof connected | typeof reconnecting | typeof paused;
  const timeline = (withAppState: boolean) => {
    let state: State = connected;
    const listeners: Array<(next: State) => void> = [];
    let onAppState: (next: string) => void = () => undefined;
    const store = Object.assign(<T>(select: (current: State) => T): T => select(state), {
      getState: () => state,
      subscribe: (listener: (next: State) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
    });
    const held = createHeldConnection(
      store,
      withAppState
        ? {
            addEventListener: (_type: 'change', listener: (next: string) => void) => {
              onAppState = listener;
            },
          }
        : undefined,
    );
    const move = (next: State, at: number) => {
      t.mock.timers.setTime(at);
      state = next;
      listeners.forEach((listener) => listener(next));
    };
    move(paused, 10_000);
    t.mock.timers.setTime(310_000);
    onAppState('active');
    move(reconnecting, 310_000);
    return held;
  };

  const resumed = timeline(true);
  assert.equal(resumed.isHeld(), true, 'reconnecting after a resume stays quiet');
  t.mock.timers.setTime(310_000 + RECONNECT_GRACE_MS);
  assert.equal(resumed.isHeld(), false, 'an outage after the resume still shows');

  t.mock.timers.setTime(0);
  const control = timeline(false);
  assert.equal(
    control.isHeld(),
    false,
    'without the foreground event the pause counted as an outage',
  );
});
