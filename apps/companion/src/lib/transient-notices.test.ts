import assert from 'node:assert/strict';
import test from 'node:test';

import { type ResourceQueryState, SUPERSEDED_READ_GRACE_MS } from '@farmslot/protocol/client-cache';

import { readErrorMessage, resourceReadMessages, savedForDisplay } from './resource-read-status';

/** Every notice Companion raised from a routine refresh before the held-data audit. */
const TRANSIENT_TEXTS = [
  /Actions wait for a current read/,
  /Saved \w+ · \d+\w? old/,
  /Runner keys wait for current worker inventory/,
  /Fleet source is stale/,
  /The file observation changed during this read/,
  /Waiting for a current read/,
  /timed out/,
];

const now = 1_000_000;
const data = { rows: [] };
const routine: Array<[string, ResourceQueryState<unknown>]> = [
  ['a connected reread', { status: 'stale', data, observedAt: now - 5_000 }],
  [
    'one failed reread',
    {
      status: 'stale',
      data,
      observedAt: now - 5_000,
      error: { code: 'TIMEOUT', message: 'Request task.progress timed out after 15000ms' },
    },
  ],
  [
    'a superseded read inside the grace',
    {
      status: 'stale',
      data,
      observedAt: now - 5_000,
      error: {
        code: 'RESOURCE_OBSERVATION_CHANGED',
        message:
          'The file observation changed during this read. Retry against the current producer.',
      },
    },
  ],
];

// Arthur: saved data is the normal state; routine refreshes and short reconnects stay silent.
test('no saved, stale or wait notice renders for a routine refresh or a short reconnect', () => {
  // Connected, or within the reconnect grace: the held connection counts as connected.
  const connected = true;
  for (const [name, observation] of routine) {
    const shown = [
      ...resourceReadMessages([{ label: 'runs', observation }], now, connected),
      readErrorMessage(observation, connected, now) ?? '',
    ].join(' ');
    for (const text of TRANSIENT_TEXTS)
      assert.doesNotMatch(shown, text, `${name} must not show ${text}`);
    assert.equal(savedForDisplay(observation, connected, now), false, name);
  }
  // A real, persistent failure still says so, once.
  const outage = resourceReadMessages([{ label: 'runs', observation: routine[0]![1] }], now, false);
  assert.deepEqual(outage, ['Saved runs · 5s old']);
  // Reads that keep failing past the shared threshold are saved data and say so.
  const failing = routine[1]![1];
  assert.match(
    readErrorMessage(failing, true, now - 5_000 + SUPERSEDED_READ_GRACE_MS) ?? '',
    /timed out/,
  );
  const superseded = routine[2]![1];
  assert.match(
    readErrorMessage(superseded, true, now - 5_000 + SUPERSEDED_READ_GRACE_MS) ?? '',
    /The file observation changed/,
    'A superseded read past the shared grace is shown',
  );
});
