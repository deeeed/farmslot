import assert from 'node:assert/strict';
import test from 'node:test';

import { PREPARE_PHASES, type PrepareRequirement } from '@farmslot/protocol';

import type { RawProjectJson } from '../../core/index.js';
import { makeVars } from '../../runners/test-fixtures.js';

import {
  buildDepsFingerprintCommand,
  buildDepsSentinelWriteCommand,
  checkPrepareRequirement,
  depsSentinelPath,
  expandPrepareProfileHook,
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

const CORE_AND_COMPATIBILITY: RawProjectJson = {
  prepare: {
    core: { label: 'Core', phases: ['git', 'fixtures', 'deps'] },
    compatibility_profile: 'sandbox',
    default: 'sandbox',
    profiles: {
      sandbox: {
        phases: ['git', 'fixtures', 'deps', 'preflight', 'health'],
        hooks: { preflight: 'start sandbox' },
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

test('core is implicit while explicit compatibility retains the monolithic profile', () => {
  const implicit = resolvePrepareProfile(CORE_AND_COMPATIBILITY);
  assert.equal(implicit.name, 'core');
  assert.deepEqual([...implicit.phases], ['git', 'fixtures', 'deps']);
  assert.deepEqual(implicit.hooks, {});

  const explicit = resolvePrepareProfile(CORE_AND_COMPATIBILITY, 'sandbox');
  const compatibility = resolvePrepareProfile(CORE_AND_COMPATIBILITY, 'compatibility');
  assert.equal(explicit.name, 'sandbox');
  assert.deepEqual([...explicit.phases], ['git', 'fixtures', 'deps', 'preflight', 'health']);
  assert.deepEqual(compatibility, explicit);
});

test('a literal compatibility profile remains selectable without the alias field', () => {
  const profile = resolvePrepareProfile(
    {
      prepare: {
        core: { phases: ['git'] },
        profiles: { compatibility: { phases: ['git', 'deps', 'health'] } },
      },
    },
    'compatibility',
  );
  assert.equal(profile.name, 'compatibility');
  assert.deepEqual(profile.phases, new Set(['git', 'deps', 'health']));
});

test('resolvePrepareProfile materializes hooks/requires/fallback', () => {
  const profile = resolvePrepareProfile(PROFILES, 'relaunch');
  assert.equal(profile.label, 'Relaunch');
  assert.deepEqual([...profile.phases], ['git', 'preflight', 'health']);
  assert.deepEqual(profile.hooks, { preflight: 'bash relaunch.sh' });
  assert.deepEqual(profile.requires, ['dev_server_up']);
  assert.equal(profile.fallback, 'full');
});

test('prepare profile override expansion rejects a missing Metro resource', () => {
  const profile = resolvePrepareProfile(
    {
      prepare: {
        profiles: {
          full: {
            phases: ['preflight'],
            hooks: { preflight: 'prepare --metro-port {{metro_port}}' },
          },
        },
      },
    },
    'full',
  );
  assert.throws(
    () =>
      expandPrepareProfileHook('preflight', profile, {}, {
        slotId: 'legacy-farmslot-1',
        resourceVars: { port: '8808' },
      } as never),
    /legacy-farmslot-1.*resources\.dev-server\.metro_port.*farmslot update/u,
  );
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

test('a pinned selection skips only the artifact probe and keeps the rest strict', async () => {
  // A pinned run's preflight proves its build, so artifact_available is not probed.
  // Every other requirement still runs, strictly: a failure refuses, never falls back.
  const projectJson: RawProjectJson = {
    prepare: {
      profiles: {
        runtime: { phases: ['git', 'deps', 'preflight'] },
        runway: {
          phases: ['git', 'deps', 'preflight'],
          requires: ['artifact_available', 'health_ok'],
          fallback: 'runtime',
          pinned_kind: 'runway',
        },
      },
    },
  };
  const ctx = { vars: {} as never, projectJson, runtimeDir: '.agent' };
  const checked: PrepareRequirement[] = [];
  const check = (healthy: boolean) => async (requirement: PrepareRequirement) => {
    checked.push(requirement);
    return { requirement, ok: requirement === 'health_ok' ? healthy : false, detail: 'probe' };
  };
  const pinned = { strict: true, skip: ['artifact_available'] as const };
  const selected = await selectPrepareProfile(ctx, 'runway', undefined, check(true), pinned);
  assert.equal(selected.profile.name, 'runway');
  assert.deepEqual(checked, ['health_ok'], 'the artifact probe did not run');
  await assert.rejects(
    () => selectPrepareProfile(ctx, 'runway', undefined, check(false), pinned),
    /Prepare profile 'runway' preconditions failed \(health_ok: probe\)/,
  );

  // An unpinned prepare still probes the artifact and walks the fallback.
  checked.length = 0;
  const unpinned = await selectPrepareProfile(ctx, 'runway', undefined, check(true));
  assert.equal(unpinned.profile.name, 'runtime');
  assert.ok(checked.includes('artifact_available'));
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
  assert.equal(
    probeFailureReason('resolving...\nno artifact for ios@main\n', ''),
    'no artifact for ios@main',
  );
  assert.equal(
    probeFailureReason('', 'gh not authenticated — run gh auth login\n'),
    'gh not authenticated — run gh auth login',
  );
  assert.equal(probeFailureReason('stdout wins\n', 'stderr ignored\n'), 'stdout wins');
  assert.equal(probeFailureReason('', '  \n \n'), undefined);
});

// Release clears the farm-owned paths a pack declares in fixtures.owned_paths —
// the installed skills among them — and prepare's deps phase restores them. A
// profile that skips deps (attach runs only `health`) therefore reaches task init
// with a required skill missing and the run is refused before dispatch. This
// check lets such a profile fall back to one that reinstalls them.
test('checkPrepareRequirement required_skills_present fails when a named file is missing', async () => {
  const probed: string[] = [];
  const exec = async (_vars: unknown, command: string) => {
    probed.push(command);
    return { exitCode: 1, stdout: '.agents/skills/mms-perps-review-pr/SKILL.md ', stderr: '' };
  };
  const result = await checkPrepareRequirement(
    'required_skills_present',
    {
      vars: { remoteRepo: '/repo' } as never,
      projectJson: {
        required_skills: {
          root: '.agents/skills',
          rules: [
            {
              id: 'perps-review',
              when: { flows: ['dev', 'fix-bug'], domains: ['perps'] },
              skills: [
                {
                  name: 'mms-perps-review-pr',
                  files: ['SKILL.md'],
                  review: { pack: 'references/pack.json', client: 'terminal', level: 'static' },
                },
              ],
            },
          ],
        },
        // A pack's owned_paths registry is far wider than what a repo installs,
        // so it is deliberately not what this check reads.
        fixtures: {
          owned_paths: [{ path: '.agents/skills/mms-never-installed', state: 'current' }],
        },
      },
      runtimeDir: '.agent',
      flow: 'fix-bug',
      domain: 'perps',
    },
    exec as never,
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /mms-perps-review-pr\/SKILL\.md/);
  assert.equal(probed.length, 1);
  assert.match(probed[0], /references\/pack\.json/, 'the review pack is required too');
  assert.doesNotMatch(probed[0], /mms-never-installed/, 'owned_paths are not probed');
});

test('checkPrepareRequirement required_skills_present passes when every named file exists', async () => {
  const result = await checkPrepareRequirement(
    'required_skills_present',
    {
      vars: { remoteRepo: '/repo' } as never,
      projectJson: {
        required_skills: {
          root: '.agents/skills',
          rules: [{ id: 'r', skills: [{ name: 'mms-perps-review-pr', files: ['SKILL.md'] }] }],
        },
      },
      runtimeDir: '.agent',
      flow: 'fix-bug',
    },
    (async () => ({ exitCode: 0, stdout: '', stderr: '' })) as never,
  );
  assert.equal(result.ok, true);
});

test('checkPrepareRequirement required_skills_present passes when the pack declares none', async () => {
  const result = await checkPrepareRequirement('required_skills_present', {
    vars: { remoteRepo: '/repo' } as never,
    projectJson: {},
    runtimeDir: '.agent',
  });
  assert.equal(result.ok, true);
  assert.match(result.detail, /no required skills/);
});

// Selection knows the flow and domain this prepare serves, so the check asks for
// the rules task init will freeze rather than every rule the pack declares.
test('checkPrepareRequirement required_skills_present asks only for the matching rules', async () => {
  const probed: string[] = [];
  const projectJson = {
    required_skills: {
      root: '.agents/skills',
      rules: [
        {
          id: 'perps-review',
          when: { flows: ['dev', 'fix-bug'], domains: ['perps'] },
          skills: [{ name: 'mms-perps-review-pr', files: ['SKILL.md'] }],
        },
        {
          id: 'mobile-testing',
          when: { flows: ['dev'], platforms: ['ios'] },
          skills: [{ name: 'mms-mobile-testing', files: ['SKILL.md'] }],
        },
      ],
    },
  };
  const exec = async (_vars: unknown, command: string) => {
    probed.push(command);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const result = await checkPrepareRequirement(
    'required_skills_present',
    {
      vars: { remoteRepo: '/repo', platform: 'cli' } as never,
      projectJson,
      runtimeDir: '.agent',
      flow: 'fix-bug',
      domain: 'perps',
    },
    exec as never,
  );
  assert.equal(result.ok, true);
  assert.match(probed[0], /mms-perps-review-pr/);
  assert.doesNotMatch(
    probed[0],
    /mms-mobile-testing/,
    'a rule this run does not match is not asked for',
  );
});

// The probes run under the prepare's effective domain, not the slot's default one.
test('checkPrepareRequirement dev_server_up and artifact_available use the run domain env', async () => {
  const probed: string[] = [];
  const exec: NonNullable<Parameters<typeof checkPrepareRequirement>[2]> = async (_vars, command) => {
    probed.push(command);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const projectJson = {
    hooks: { dev_server_check: 'check-dev-server', artifact_check: 'check-artifact' },
    command_env: {
      domains: {
        perps: { set: { PROBE_DOMAIN: 'perps' } },
        'money-movement': { set: { PROBE_DOMAIN: 'money-movement' } },
      },
    },
  };
  for (const requirement of ['dev_server_up', 'artifact_available'] as const) {
    probed.length = 0;
    const result = await checkPrepareRequirement(
      requirement,
      {
        vars: makeVars({ remoteRepo: '/repo', domain: 'perps' }),
        projectJson,
        runtimeDir: '.agent',
        domain: 'money-movement',
      },
      exec,
    );
    assert.equal(result.ok, true, `${requirement}: ${result.detail}`);
    assert.match(probed[0] ?? '', /PROBE_DOMAIN=.?money-movement/, requirement);
    assert.doesNotMatch(probed[0] ?? '', /PROBE_DOMAIN=.?perps/, requirement);
  }
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
