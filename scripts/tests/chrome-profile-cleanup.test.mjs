import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import cleanup from '../../apps/command-center/scripts/chrome-profile-cleanup.cjs';

function fixture(t, port = 47201) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-profile-cleanup-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = path.join(home, `.chrome-farmslot-${port}`);
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'proof.txt'), 'disposable');
  const slot = {
    slot: 'fixture-slot',
    machine: 'fixture-machine',
    lifecycle: 'ready',
    agent: 'idle',
    currentRunId: null,
    taskId: null,
    resources: { browser: { cdp_port: port } },
  };
  const fleet = { checkedAt: new Date().toISOString(), slots: [slot] };
  return {
    home,
    profile,
    slot,
    fleet,
    options: {
      home,
      machine: 'fixture-machine',
      getFleet: () => fleet,
      profilePids: () => [],
      listenerPids: () => [],
    },
  };
}

test('reaps dead per-port profiles but preserves custom profiles and symlinks', async (t) => {
  const f = fixture(t);
  const unbound = path.join(f.home, '.chrome-farmslot-47202');
  const custom = path.join(f.home, '.chrome-farmslot-custom');
  const linked = path.join(f.home, '.chrome-farmslot-47203');
  fs.mkdirSync(unbound);
  fs.mkdirSync(custom);
  fs.symlinkSync(custom, linked);
  const result = await cleanup.reapProfiles(f.options);
  assert.deepEqual(result.removed.sort(), [f.profile, unbound].sort());
  assert.equal(fs.existsSync(f.profile), false);
  assert.equal(fs.existsSync(custom), true);
  assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
});

test('preserves live, held, manual and claimed slots even without CDP', async (t) => {
  const f = fixture(t);
  for (const lifecycle of ['busy', 'held', 'manual']) {
    f.slot.lifecycle = lifecycle;
    assert.deepEqual((await cleanup.reapProfiles(f.options)).removed, []);
    assert.equal(fs.existsSync(f.profile), true);
  }
  f.slot.lifecycle = 'ready';
  f.slot.currentRunId = 'fixture-live-run';
  assert.deepEqual((await cleanup.reapProfiles(f.options)).removed, []);
  f.slot.currentRunId = null;
  f.slot.agent = 'working';
  assert.deepEqual((await cleanup.reapProfiles(f.options)).removed, []);
});

test('preserves browser processes, listeners and failed ownership probes', async (t) => {
  const f = fixture(t);
  for (const probes of [
    { profilePids: () => [process.pid] },
    { listenerPids: () => [process.pid] },
    {
      listenerPids: () => {
        throw new Error('unavailable');
      },
    },
  ]) {
    assert.deepEqual((await cleanup.reapProfiles({ ...f.options, ...probes })).removed, []);
    assert.equal(fs.existsSync(f.profile), true);
  }
});

test('preserves profiles when fleet ownership is stale, missing or unavailable', async (t) => {
  const f = fixture(t);
  for (const fleet of [
    { ...f.fleet, stale: true },
    { ...f.fleet, checkedAt: 'invalid' },
    { ...f.fleet, checkedAt: new Date(0).toISOString() },
    { ...f.fleet, slots: [] },
    { ...f.fleet, slots: [{ ...f.slot, resources: undefined }] },
  ]) {
    assert.deepEqual(
      (await cleanup.reapProfiles({ ...f.options, getFleet: () => fleet })).removed,
      [],
    );
  }
  const result = await cleanup.reapProfiles({
    ...f.options,
    getFleet: () => {
      throw new Error('offline');
    },
  });
  assert.equal(result.skipped, 'gateway slot ownership unavailable');
  assert.equal(fs.existsSync(f.profile), true);
});

test('excludes the launching profile and scopes stop cleanup to its own profile', async (t) => {
  const f = fixture(t);
  assert.deepEqual(
    (await cleanup.reapProfiles({ ...f.options, excludeProfile: f.profile })).removed,
    [],
  );
  const other = path.join(f.home, '.chrome-farmslot-47202');
  fs.mkdirSync(other);
  f.slot.lifecycle = 'busy';
  f.slot.phase = 'releasing';
  f.slot.currentRunId = 'fixture-ending-run';
  assert.deepEqual((await cleanup.reapProfiles({ ...f.options, onlyProfile: f.profile })).removed, [
    f.profile,
  ]);
  assert.equal(fs.existsSync(other), true);
});

test('custom stop profiles never enter automatic home-profile cleanup', async (t) => {
  const f = fixture(t);
  const custom = path.join(f.home, 'custom-profile');
  fs.mkdirSync(custom);
  const result = await cleanup.reapProfiles({
    ...f.options,
    onlyProfile: custom,
    getFleet: () => {
      throw new Error('must not query');
    },
  });
  assert.deepEqual(result.kept, [custom]);
  assert.equal(fs.existsSync(custom), true);
});

test('launch and cleanup serialize on the same profile lock', async (t) => {
  const f = fixture(t);
  let competingRan = false;
  await cleanup.profileLock(
    f.profile,
    async () => {
      await assert.rejects(
        cleanup.profileLock(
          f.profile,
          () => {
            competingRan = true;
          },
          { home: f.home, waitMs: 30 },
        ),
        /Timed out/,
      );
    },
    { home: f.home },
  );
  assert.equal(competingRan, false);
  await cleanup.profileLock(
    f.profile,
    () => {
      competingRan = true;
    },
    { home: f.home },
  );
  assert.equal(competingRan, true);
});
