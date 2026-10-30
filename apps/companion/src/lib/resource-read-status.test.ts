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
  );
  assert.equal(messages.length, 2);
  assert.match(messages[0], /Saved runs, 1m old/);
  assert.equal(messages[1], 'Could not read runs: Gateway unavailable');
});

test('a ready view is quiet and unsupported reads keep their reason', () => {
  assert.deepEqual(
    resourceReadMessages([{ label: 'run', observation: { status: 'ready', data: {} } }], 0),
    [],
  );
  assert.deepEqual(
    resourceReadMessages([{ label: 'run', observation: { status: 'loading' } }], 0),
    [],
  );
  assert.deepEqual(
    resourceReadMessages([{ label: 'run', observation: { status: 'unsupported' } }], 0),
    ['Live run updates are unavailable on this gateway.'],
  );
});
