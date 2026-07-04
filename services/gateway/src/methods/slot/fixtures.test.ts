import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFixtureSyncCommand,
  buildFixtureSyncTimeoutMessage,
  FIXTURE_SYNC_TIMEOUT_ENV_VAR,
  LOCAL_FIXTURE_SYNC_TIMEOUT_MS,
  REMOTE_FIXTURE_SYNC_TIMEOUT_MS,
  resolveFixtureSyncTimeoutMs,
} from './fixtures.js';

test('buildFixtureSyncCommand forwards flow type, app, and domain when set', () => {
  const cmd = buildFixtureSyncCommand('macwork-mm-1', 'fix-bug', 'apps/example', 'blue');
  assert.match(cmd, /sync-fixtures\.sh/);
  assert.match(cmd, /'--slot' 'macwork-mm-1'/);
  assert.match(cmd, /'--flow-type' 'fix-bug'/);
  assert.match(cmd, /'--app' 'apps\/example'/);
  assert.match(cmd, /'--domain' 'blue'/);
});

test('buildFixtureSyncCommand omits --domain when no domain is set', () => {
  const cmd = buildFixtureSyncCommand('macwork-mm-1', 'fix-bug');
  assert.doesNotMatch(cmd, /--domain/);
  assert.doesNotMatch(cmd, /--app/);
});

test('local fixture-sync backstop clears real ~60s single-domain runtime', () => {
  // Regression: the old 60s local limit killed healthy syncs (exit 124) at their
  // measured runtime. The backstop must sit well clear of normal completion.
  assert.ok(
    LOCAL_FIXTURE_SYNC_TIMEOUT_MS >= 300_000,
    `expected >= 300000ms backstop, got ${LOCAL_FIXTURE_SYNC_TIMEOUT_MS}`,
  );
});

test('resolveFixtureSyncTimeoutMs selects the per-host backstop', () => {
  assert.equal(
    resolveFixtureSyncTimeoutMs({ host: 'localhost', machine: 'macwork' } as never),
    LOCAL_FIXTURE_SYNC_TIMEOUT_MS,
  );
  assert.equal(
    resolveFixtureSyncTimeoutMs({ host: 'remote.example', machine: 'node-1' } as never),
    REMOTE_FIXTURE_SYNC_TIMEOUT_MS,
  );
});

test('buildFixtureSyncTimeoutMessage teaches elapsed vs limit, log, re-run, and the override that works', () => {
  const msg = buildFixtureSyncTimeoutMessage({
    slotId: 'macwork-mm2-1',
    elapsedMs: 60_117,
    timeoutMs: 300_000,
    logPath: '/tmp/fixture-refresh/macwork-mm2-1.log',
    envFilePath: '/repo/.env',
    prepareProfile: 'runway',
  });
  assert.match(msg, /60117ms/);
  assert.match(msg, /300000ms/);
  assert.match(msg, /macwork-mm2-1/);
  assert.match(msg, /\/tmp\/fixture-refresh\/macwork-mm2-1\.log/);
  assert.match(msg, /farmslot slot prepare macwork-mm2-1 --prepare-profile runway/);
  // The override must teach the mechanism that actually works: the running
  // gateway reads the var from .env at startup, so the escape is edit-.env +
  // restart — never a CLI-side env prefix (which the daemon never sees).
  assert.ok(msg.includes(FIXTURE_SYNC_TIMEOUT_ENV_VAR));
  assert.match(msg, /\/repo\/\.env/);
  assert.match(msg, /farmslot down && farmslot up/);
  assert.doesNotMatch(msg, /FARMSLOT_FIXTURE_SYNC_TIMEOUT_MS=<ms> farmslot slot prepare/);
});

test('buildFixtureSyncTimeoutMessage emits the prepare profile, not the slot domain', () => {
  // Regression guard: on a slot whose domain is 'perps' but whose selected
  // prepare profile is 'runway', the re-run hint must carry the profile
  // ('runway') — the domain ('perps') must never leak into --prepare-profile.
  const msg = buildFixtureSyncTimeoutMessage({
    slotId: 'macwork-mm2-1',
    elapsedMs: 60_117,
    timeoutMs: 300_000,
    logPath: '/tmp/x.log',
    envFilePath: '/repo/.env',
    prepareProfile: 'runway',
  });
  assert.match(msg, /--prepare-profile runway/);
  assert.doesNotMatch(msg, /perps/);
});

test('buildFixtureSyncTimeoutMessage falls back to a <profile> placeholder', () => {
  const msg = buildFixtureSyncTimeoutMessage({
    slotId: 'macwork-mm2-1',
    elapsedMs: 61_000,
    timeoutMs: 300_000,
    logPath: '/tmp/x.log',
    envFilePath: '/repo/.env',
  });
  assert.match(msg, /farmslot slot prepare macwork-mm2-1 --prepare-profile <profile>/);
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
