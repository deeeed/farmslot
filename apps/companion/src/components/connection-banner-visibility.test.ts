import assert from 'node:assert/strict';
import test from 'node:test';

import { mountHook } from '../hooks/hook-harness.fixtures';
import { createOfflineClock, RECONNECT_GRACE_MS } from '../lib/held-connection';

import { resolveBannerContent } from './connection-banner-visibility';

type Banner = { tone: string; title: string };
type Args = [Banner | null, { held: boolean; stuck: boolean; outage: Banner }];

const outage = { tone: 'disconnected', title: 'Gateway offline' };
const connecting = { tone: 'connecting', title: 'Connecting…' };

// GatewayClient retries at most every 30 s, under the 60 s grace, so an unreachable gateway
// cycles disconnected → connecting → disconnected.
test('an outage that cycles through reconnect attempts shows once the grace has passed', () => {
  // usePersistentFlag on the test's clock: true once the flag has held for the grace, and
  // restarting whenever it drops, as the real one does.
  let now = 0;
  let since: number | null = null;
  const usePersistentFlag = (flag: boolean) => {
    if (!flag) since = null;
    else if (since === null) since = now;
    return flag && since !== null && now - since >= RECONNECT_GRACE_MS;
  };
  const hook = mountHook<Args>(
    new URL('./connection-banner-visibility.ts', import.meta.url),
    'useVisibleConnectionBanner',
    { '../lib/held-connection': { usePersistentFlag } },
  );
  try {
    const start = 1_000_000;
    const clock = createOfflineClock(start);
    const at = (seconds: number, status: 'connected' | 'connecting' | 'disconnected') => {
      const state = { status, client: { connectionState: status } };
      now = start + seconds * 1_000;
      return clock.held(state, now);
    };
    const show = (held: boolean, banner: Banner) =>
      hook.render(banner, { held, stuck: false, outage });

    assert.equal(show(at(0, 'connected'), connecting), null);
    assert.equal(show(at(10, 'disconnected'), outage), null, 'a short drop stays quiet');
    assert.equal(show(at(40, 'connecting'), connecting), null);
    assert.equal(show(at(55, 'disconnected'), outage), null);
    const past = 10 + RECONNECT_GRACE_MS / 1_000 + 5;
    assert.deepEqual(show(at(past, 'connecting'), connecting), outage, 'shows while reconnecting');
    assert.deepEqual(show(at(past + 20, 'disconnected'), outage), outage);
    assert.equal(show(at(past + 30, 'connected'), connecting), null, 'back once connected');
  } finally {
    hook.cleanup();
  }
});

// Arthur: status stays discreet, and less text is always better.
test('every banner a person can see is a few words, never the raw error', () => {
  const show = (...args: Parameters<typeof resolveBannerContent>) =>
    resolveBannerContent(...args).title;
  const titles = [
    show('disconnected', null, null, null, 'mini'),
    show('socket-up-not-proven', null, null, null, 'mini'),
    show('degraded', null, null, null, 'mini'),
    show(
      'healthy',
      'Failed to refresh decisions: request timed out after 15000ms',
      null,
      null,
      'mini',
    ),
    show('healthy', null, null, 'Connected to an older gateway without gateway.ping.', 'mini'),
  ];
  assert.deepEqual(titles, [
    'Gateway offline',
    'Gateway not answering',
    'Gateway not answering',
    'Sync failed',
    'Gateway outdated',
  ]);
});
