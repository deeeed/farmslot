import assert from 'node:assert/strict';
import test from 'node:test';

import { PREPARE_PHASES, type PrepareRequirement } from '@farmslot/protocol';

import type { RawProjectJson } from '../../core/index.js';

import {
  buildDepsFingerprintCommand,
  buildDepsSentinelWriteCommand,
  checkPrepareRequirement,
  depsSentinelPath,
  probeFailureReason,
  resolvePrepareProfile,
  selectPrepareProfile,
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

test('deps sentinel commands target the runtime dir and fingerprint harness inputs', () => {
  assert.equal(depsSentinelPath('.agent'), '.agent/deps.lock-hash');
  const write = buildDepsSentinelWriteCommand('/repo', '.agent');
  assert.match(write, /cd '\/repo'/);
  assert.doesNotMatch(write, /hash=\$\( &&/);
  assert.match(write, /hash=\$\(\n/);
  assert.match(write, /\.agent\/deps\.lock-hash/);
  assert.match(write, /package\.json/);
  assert.match(write, /yarn\.lock/);
  assert.match(write, /command -v node/);
  assert.match(write, /node -e/);
  assert.match(write, /sha256sum/);
  assert.match(write, /rm -f/); // no deps inputs → sentinel removed, deps_current stays failing
  const fingerprint = buildDepsFingerprintCommand('/repo');
  assert.match(fingerprint, /command -v node/);
  assert.match(fingerprint, /node -e/);
  assert.match(fingerprint, /\.tool-versions/);
  assert.match(fingerprint, /shasum -a 256/);
});

test('selectPrepareProfile walks multi-hop fallback chain on failing checks', async () => {
  const projectJson: RawProjectJson = {
    prepare: {
      profiles: {
        full: { phases: ['git', 'deps'] },
        relaunch: { phases: ['git'], requires: ['dev_server_up'], fallback: 'full' },
        attach: { phases: ['health'], requires: ['health_ok'], fallback: 'relaunch' },
      },
    },
  };
  const ctx = {
    vars: {} as never,
    projectJson,
    runtimeDir: '.agent',
  };
  const checked: string[] = [];
  const failingCheck = async (requirement: PrepareRequirement) => {
    checked.push(requirement);
    return { requirement, ok: false, detail: 'forced failure' };
  };
  const selection = await selectPrepareProfile(ctx, 'attach', undefined, failingCheck);
  assert.equal(selection.profile.name, 'full');
  assert.deepEqual(
    selection.fallbacks.map((f) => `${f.from}->${f.to}`),
    ['attach->relaunch', 'relaunch->full'],
  );
  assert.deepEqual(checked, ['health_ok', 'dev_server_up']);

  const passingCheck = async (requirement: PrepareRequirement) => ({
    requirement,
    ok: true,
    detail: 'forced pass',
  });
  const direct = await selectPrepareProfile(ctx, 'attach', undefined, passingCheck);
  assert.equal(direct.profile.name, 'attach');
  assert.deepEqual(direct.fallbacks, []);
});

test('selectPrepareProfile strict mode fails fast without walking fallback chain', async () => {
  const projectJson: RawProjectJson = {
    prepare: {
      profiles: {
        full: { phases: ['git', 'deps'] },
        attach: { phases: ['health'], requires: ['health_ok'], fallback: 'full' },
      },
    },
  };
  const ctx = {
    vars: {} as never,
    projectJson,
    runtimeDir: '.agent',
  };
  const failingCheck = async (requirement: PrepareRequirement) => ({
    requirement,
    ok: false,
    detail: 'health value=none expected=WalletView',
  });
  await assert.rejects(
    () => selectPrepareProfile(ctx, 'attach', undefined, failingCheck, { strict: true }),
    /preconditions failed.*health_ok/,
  );
});

test('selectPrepareProfile walks an artifact_available profile to its declared fallback', async () => {
  // Mirrors the mobile farm's runway → ensure-js-runtime wiring: the default
  // profile gates on artifact_available and falls back when no artifact resolves.
  const projectJson: RawProjectJson = {
    prepare: {
      default: 'runway',
      profiles: {
        'ensure-js-runtime': { phases: ['git', 'deps', 'preflight', 'health'] },
        runway: {
          phases: ['git', 'preflight', 'health'],
          requires: ['artifact_available'],
          fallback: 'ensure-js-runtime',
        },
      },
    },
  };
  const ctx = { vars: {} as never, projectJson, runtimeDir: '.agent' };

  const unavailable = await selectPrepareProfile(
    ctx,
    undefined,
    undefined,
    async (requirement) => ({
      requirement,
      ok: false,
      detail: 'no Runway artifact resolvable',
    }),
  );
  assert.equal(unavailable.profile.name, 'ensure-js-runtime');
  assert.deepEqual(
    unavailable.fallbacks.map((f) => `${f.from}->${f.to}`),
    ['runway->ensure-js-runtime'],
  );

  const available = await selectPrepareProfile(ctx, undefined, undefined, async (requirement) => ({
    requirement,
    ok: true,
    detail: 'artifact_check passed',
  }));
  assert.equal(available.profile.name, 'runway');
  assert.deepEqual(available.fallbacks, []);
});

test('probeFailureReason prefers stdout but falls back to stderr', () => {
  assert.equal(probeFailureReason('resolving...\nno artifact for ios@main\n', ''), 'no artifact for ios@main');
  assert.equal(probeFailureReason('', 'gh not authenticated — run gh auth login\n'), 'gh not authenticated — run gh auth login');
  assert.equal(probeFailureReason('stdout wins\n', 'stderr ignored\n'), 'stdout wins');
  assert.equal(probeFailureReason('', '  \n \n'), undefined);
});

test('checkPrepareRequirement artifact_available fails when no artifact_check hook is declared', async () => {
  // Missing-hook path needs no slot exec: expandHook returns '' and the check
  // fails with a teaching detail before any remote command runs.
  const result = await checkPrepareRequirement('artifact_available', {
    vars: { remoteRepo: '/repo' } as never,
    projectJson: { hooks: {} },
    runtimeDir: '.agent',
  });
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'project has no artifact_check hook');
});
