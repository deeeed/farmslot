import assert from 'node:assert/strict';
import test from 'node:test';

import type { GatewayUpdateStatus } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import {
  notificationTray,
  publishReadNotice,
  publishUpdateNotice,
  updateNoticeKey,
} from './notification-tray.js';

test('tray notices follow the shared saved-age policy instead of every in-flight read', () => {
  notificationTray.setOwner('saved-policy');
  const source = {};
  const query = resourceQuery('run.get', { runId: 'held' });
  const observedAt = Date.now();
  const held = { status: 'stale', data: {}, observedAt } as const;
  publishReadNotice(source, 'saved-policy', query, held, '#runs', { connected: true });
  assert.equal(notificationTray.items.length, 0, 'an ordinary refetch stays quiet');
  publishReadNotice(
    source,
    'saved-policy',
    query,
    {
      ...held,
      error: { code: 'RESOURCE_OBSERVATION_CHANGED', message: 'Source advanced during read' },
    },
    '#runs',
    { connected: true },
  );
  assert.equal(notificationTray.items.length, 0, 'a superseded read follows its scheduled reread');
  publishReadNotice(
    source,
    'saved-policy',
    query,
    {
      ...held,
      observedAt: observedAt - 60_001,
      error: { code: 'RESOURCE_OBSERVATION_CHANGED', message: 'Source advanced during read' },
    },
    '#runs',
    { connected: true },
  );
  assert.equal(notificationTray.items[0]?.title, 'Saved run');
  publishReadNotice(
    source,
    'saved-policy',
    query,
    {
      ...held,
      error: { code: 'UNAVAILABLE', message: 'Source unavailable' },
    },
    '#runs',
    { connected: true },
  );
  assert.equal(notificationTray.items[0]?.body, 'Source unavailable');
  assert.equal(notificationTray.items[0]?.needsYou, false);
  notificationTray.setOwner(undefined);
});

test('read notices deduplicate the same query across routes and keep distinct subjects', () => {
  notificationTray.setOwner('test-owner');
  const first = {},
    duplicate = {},
    other = {};
  const run = resourceQuery('run.get', { runId: 'first' });
  const failed = { status: 'error', error: { code: 'UNAVAILABLE', message: 'Try again' } } as const;
  publishReadNotice(first, 'test-owner', run, failed, '#fleet', { connected: true });
  publishReadNotice(duplicate, 'test-owner', run, failed, '#runs', { connected: true });
  assert.equal(notificationTray.items.length, 1);
  assert.equal(notificationTray.items[0]?.route, '#run/first');
  publishReadNotice(
    other,
    'test-owner',
    resourceQuery('run.get', { runId: 'second' }),
    failed,
    '#runs',
    { connected: true },
  );
  assert.equal(notificationTray.items.length, 2);
  assert(notificationTray.items.every((item) => !item.needsYou));
  publishReadNotice(first, 'test-owner', run, { status: 'ready' }, '#fleet', { connected: true });
  notificationTray.clear(duplicate);
  assert.equal(notificationTray.items.length, 1);
  notificationTray.setOwner(undefined);
  assert.equal(notificationTray.items.length, 0);
});

test('completed update guidance remains reachable until its existing dismissal is acknowledged', () => {
  notificationTray.setOwner('updates');
  const status: GatewayUpdateStatus = {
    updateAvailable: false,
    commitsBehind: 0,
    commitsAhead: 0,
    branch: 'main',
    localSha: 'abc',
    remoteSha: 'abc',
    lastChecked: null,
    updateCommand: 'farmslot update',
    error: null,
    operation: {
      id: 'update-1',
      phase: 'complete',
      message: 'Restart the gateway and rebuild desktop',
      updatedAt: '2026-10-30T00:00:00Z',
      localSha: 'old',
      targetSha: 'abc',
      gatewayRestartRequired: true,
      desktopRebuildRequired: true,
    },
  };
  publishUpdateNotice('updates', status);
  assert.equal(notificationTray.items[0]?.view, 'update');
  assert.equal(notificationTray.items[0]?.body, status.operation?.message);
  publishUpdateNotice('updates', status, updateNoticeKey(status));
  assert.equal(notificationTray.items.length, 0);
  publishUpdateNotice('updates', {
    ...status,
    operation: { ...status.operation!, phase: 'error' },
  });
  assert.equal(notificationTray.items[0]?.title, 'Farmslot update failed');
  notificationTray.setOwner(undefined);
});

test('missing runs stay absent and unsupported progress is one quiet gateway condition', () => {
  notificationTray.setOwner('reads');
  publishReadNotice(
    {},
    'reads',
    resourceQuery('run.get', { runId: 'gone' }),
    { status: 'error', error: { code: 'RUN_NOT_FOUND', message: 'Run no longer exists' } },
    '#runs',
    { connected: true },
  );
  assert.equal(notificationTray.items.length, 0);
  publishReadNotice(
    {},
    'reads',
    resourceQuery('task.progress', { runId: 'one' }),
    { status: 'unsupported' },
    '#run/one',
    { connected: true },
  );
  publishReadNotice(
    {},
    'reads',
    resourceQuery('task.progress', { runId: 'two' }),
    { status: 'unsupported' },
    '#run/two',
    { connected: true },
  );
  assert.equal(notificationTray.items.length, 1);
  assert.equal(notificationTray.items[0]?.needsYou, false);
  notificationTray.setOwner(undefined);
});
