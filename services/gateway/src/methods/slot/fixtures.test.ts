import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFixtureSyncCommand,
  LOCAL_FIXTURE_SYNC_TIMEOUT_MS,
  REMOTE_FIXTURE_SYNC_TIMEOUT_MS,
  resolveFixtureSyncTimeoutMs,
} from './fixtures.js';

test('buildFixtureSyncCommand forwards flow type, app, and team when set', () => {
  const cmd = buildFixtureSyncCommand('macwork-mm-1', 'fix-bug', 'apps/example', 'blue');
  assert.match(cmd, /sync-fixtures\.sh/);
  assert.match(cmd, /'--slot' 'macwork-mm-1'/);
  assert.match(cmd, /'--flow-type' 'fix-bug'/);
  assert.match(cmd, /'--app' 'apps\/example'/);
  assert.match(cmd, /'--team' 'blue'/);
});

test('buildFixtureSyncCommand omits --team when no team is set', () => {
  const cmd = buildFixtureSyncCommand('macwork-mm-1', 'fix-bug');
  assert.doesNotMatch(cmd, /--team/);
  assert.doesNotMatch(cmd, /--app/);
});

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
