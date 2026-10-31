import assert from 'node:assert/strict';
import test from 'node:test';

import { resourceReadMessages } from './resource-read-status';

test('saved facts retain their source age alongside a refresh failure', () => {
  const messages = resourceReadMessages(
    [
      {
        label: 'runs',
        observation: {
          status: 'stale',
          data: { runs: [] },
          observedAt: 90_000,
          sourceObservation: { status: 'stale', observedAt: 1_000 },
          error: { code: 'UNAVAILABLE', message: 'Gateway unavailable' },
        },
      },
    ],
    61_000,
    true,
  );
  assert.equal(messages.length, 2);
  assert.match(messages[0], /Saved runs · 1m old/);
  assert.equal(messages[1], 'Could not read runs: Gateway unavailable');
});

test('a ready view is quiet and unsupported reads keep their reason', () => {
  assert.deepEqual(
    resourceReadMessages([{ label: 'run', observation: { status: 'ready', data: {} } }], 0, true),
    [],
  );
  assert.deepEqual(
    resourceReadMessages([{ label: 'run', observation: { status: 'loading' } }], 0, true),
    [],
  );
  assert.deepEqual(
    resourceReadMessages([{ label: 'run', observation: { status: 'unsupported' } }], 0, true),
    ['No live run updates'],
  );
});

// Pixel 6 on production 0.9.0: every change event flashed these over the list while connected.
test('a connected reread in flight or a fresh superseded read stays quiet', () => {
  const rereading = { status: 'stale', data: { runs: [] }, observedAt: 50_000 } as const;
  const superseded = {
    ...rereading,
    error: {
      code: 'RESOURCE_OBSERVATION_CHANGED',
      message: 'The file observation changed during this read. Retry against the current producer.',
    },
  } as const;
  const read = (observation: typeof superseded | typeof rereading, now: number, connected = true) =>
    resourceReadMessages([{ label: 'runs', observation }], now, connected);
  assert.deepEqual(read(rereading, 56_000), []);
  assert.deepEqual(read(superseded, 56_000), []);
  // Saved data still says so: offline, or superseded for longer than the shared grace.
  assert.deepEqual(read(rereading, 56_000, false), ['Saved runs · 6s old']);
  // Offline, a failed read is the outage's, which the connection banner already shows.
  assert.deepEqual(read(superseded, 56_000, false), ['Saved runs · 6s old']);
  assert.equal(read(superseded, 111_000).length, 2);
});

// Review r1: a screen with no banner (a stack route over the tabs) still says why it is empty.
test('offline, a read with nothing to show says Offline once, unless the banner does', () => {
  const failed = {
    status: 'error',
    error: { code: 'UNAVAILABLE', message: 'Connection closed' },
  } as const;
  const reads = [
    { label: 'dispatch queue', observation: failed },
    { label: 'work graph', observation: failed },
  ];
  assert.deepEqual(resourceReadMessages(reads, 0, false), ['Offline']);
  assert.deepEqual(resourceReadMessages(reads, 0, false, false), [], 'The banner says so');
  assert.deepEqual(resourceReadMessages(reads, 0, true), [
    'Could not read dispatch queue: Connection closed',
    'Could not read work graph: Connection closed',
  ]);
});
