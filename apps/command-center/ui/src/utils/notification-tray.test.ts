import assert from 'node:assert/strict';
import test from 'node:test';

import { resourceQuery } from '@farmslot/protocol/client-cache';

import { notificationTray, publishReadNotice } from './notification-tray.js';

test('read notices deduplicate the same query across routes and keep distinct subjects', () => {
  notificationTray.setOwner('test-owner');
  const first = {},
    duplicate = {},
    other = {};
  const run = resourceQuery('run.get', { runId: 'first' });
  const failed = { status: 'error', error: { code: 'UNAVAILABLE', message: 'Try again' } } as const;
  publishReadNotice(first, 'test-owner', run, failed, '#fleet');
  publishReadNotice(duplicate, 'test-owner', run, failed, '#runs');
  assert.equal(notificationTray.items.length, 1);
  assert.equal(notificationTray.items[0]?.route, '#run/first');
  publishReadNotice(
    other,
    'test-owner',
    resourceQuery('run.get', { runId: 'second' }),
    failed,
    '#runs',
  );
  assert.equal(notificationTray.items.length, 2);
  assert(notificationTray.items.every((item) => !item.needsYou));
  publishReadNotice(first, 'test-owner', run, { status: 'ready' }, '#fleet');
  notificationTray.clear(duplicate);
  assert.equal(notificationTray.items.length, 1);
  notificationTray.setOwner(undefined);
  assert.equal(notificationTray.items.length, 0);
});
