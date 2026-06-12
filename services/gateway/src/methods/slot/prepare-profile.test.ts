import assert from 'node:assert/strict';
import test from 'node:test';

import { PREPARE_PHASES } from '@farmslot/protocol';

import type { RawProjectJson } from '../../core/index.js';

import {
  buildDepsSentinelWriteCommand,
  buildLockfileHashCommand,
  depsSentinelPath,
  resolvePrepareProfile,
} from './prepare-profile.js';

const PROFILES: RawProjectJson = {
  prepare: {
    default: 'relaunch',
    profiles: {
      full: { phases: ['git', 'fixtures', 'deps', 'preflight', 'health'] },
      relaunch: {
        label: 'Relaunch',
        phases: ['git', 'preflight', 'health'],
        hooks: { preflight: 'bash relaunch.sh' },
        requires: ['dev_server_up'],
        fallback: 'full',
      },
    },
  },
};

test('resolvePrepareProfile returns implicit full without a prepare block', () => {
  const profile = resolvePrepareProfile({});
  assert.equal(profile.name, 'full');
  assert.deepEqual([...profile.phases].sort(), [...PREPARE_PHASES].sort());
  assert.deepEqual(profile.requires, []);
  assert.deepEqual(profile.hooks, {});
});

test('resolvePrepareProfile allows requesting "full" without a prepare block', () => {
  assert.equal(resolvePrepareProfile({}, 'full').name, 'full');
  assert.throws(() => resolvePrepareProfile({}, 'relaunch'), /defines no prepare profiles/);
});

test('resolvePrepareProfile honours request over default', () => {
  assert.equal(resolvePrepareProfile(PROFILES, 'full').name, 'full');
  assert.equal(resolvePrepareProfile(PROFILES).name, 'relaunch');
});

test('resolvePrepareProfile materializes hooks/requires/fallback', () => {
  const profile = resolvePrepareProfile(PROFILES, 'relaunch');
  assert.equal(profile.label, 'Relaunch');
  assert.deepEqual([...profile.phases], ['git', 'preflight', 'health']);
  assert.deepEqual(profile.hooks, { preflight: 'bash relaunch.sh' });
  assert.deepEqual(profile.requires, ['dev_server_up']);
  assert.equal(profile.fallback, 'full');
});

test('resolvePrepareProfile rejects unknown profile names', () => {
  assert.throws(
    () => resolvePrepareProfile(PROFILES, 'turbo'),
    /Unknown prepare profile 'turbo' \(available: full, relaunch\)/,
  );
});

test('resolvePrepareProfile falls back to a profile named full when no default set', () => {
  const noDefault: RawProjectJson = {
    prepare: { profiles: { full: { phases: ['git'] } } },
  };
  assert.equal(resolvePrepareProfile(noDefault).name, 'full');
});

test('deps sentinel commands target the runtime dir and cover lockfiles', () => {
  assert.equal(depsSentinelPath('.agent'), '.agent/deps.lock-hash');
  const write = buildDepsSentinelWriteCommand('/repo', '.agent');
  assert.match(write, /cd '\/repo'/);
  assert.match(write, /\.agent\/deps\.lock-hash/);
  assert.match(write, /yarn\.lock/);
  assert.match(write, /rm -f/); // no lockfile → sentinel removed, deps_current stays failing
  const hash = buildLockfileHashCommand('/repo');
  assert.match(hash, /sha256sum/);
  assert.match(hash, /shasum -a 256/);
});
