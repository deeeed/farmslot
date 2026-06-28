import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCAL_FIXTURE_SYNC_TIMEOUT_MS,
  REMOTE_FIXTURE_SYNC_TIMEOUT_MS,
  resolveFixtureSyncTimeoutMs,
} from './fixtures.js';

test('resolveFixtureSyncTimeoutMs uses shorter budget for local slots', () => {
  assert.equal(
    resolveFixtureSyncTimeoutMs({ host: 'localhost', machine: 'macwork' } as never),
    LOCAL_FIXTURE_SYNC_TIMEOUT_MS,
  );
  assert.equal(
    resolveFixtureSyncTimeoutMs({ host: 'remote.example', machine: 'node-1' } as never),
    REMOTE_FIXTURE_SYNC_TIMEOUT_MS,
  );
});

test('resolveFixtureSyncTimeoutMs honors FARMSLOT_FIXTURE_SYNC_TIMEOUT_MS', () => {
  const prev = process.env.FARMSLOT_FIXTURE_SYNC_TIMEOUT_MS;
  process.env.FARMSLOT_FIXTURE_SYNC_TIMEOUT_MS = '45000';
  try {
    assert.equal(
      resolveFixtureSyncTimeoutMs({ host: 'localhost', machine: 'macwork' } as never),
      45_000,
    );
  } finally {
    if (prev === undefined) delete process.env.FARMSLOT_FIXTURE_SYNC_TIMEOUT_MS;
    else process.env.FARMSLOT_FIXTURE_SYNC_TIMEOUT_MS = prev;
  }
});