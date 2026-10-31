import assert from 'node:assert/strict';
import test from 'node:test';

import { SUPERSEDED_READ_GRACE_MS } from '@farmslot/protocol/client-cache';

import { mountHook } from '../hooks/hook-harness.fixtures';

import { createOfflineClock, RECONNECT_GRACE_MS } from './held-connection';

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
