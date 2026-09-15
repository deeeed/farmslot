import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMachineEnvPrefix,
  buildProjectCommandEnvPrefix,
  resolveProjectCommandEnv,
  withMachineEnv,
} from './project-env.js';

test('frozen launch bindings override slot paths before expansion without hiding other unresolved values', () => {
  const project = {
    command_env: {
      unset: ['LIBRARY'],
      domains: { trading: { set: { LIBRARY: '{{slot_library}}', DOMAIN: 'trading' } } },
    },
  };
  assert.deepEqual(
    resolveProjectCommandEnv(project, {
      domain: 'trading',
      overrides: { LIBRARY: '/frozen/library' },
    }),
    {
      unset: [],
      set: { LIBRARY: '/frozen/library', DOMAIN: 'trading' },
    },
  );
  assert.throws(
    () => resolveProjectCommandEnv(project, { domain: 'trading', overrides: { OTHER: '/frozen' } }),
    /unresolved placeholder/,
  );
});

test('command_env with no domain preserves the existing base output', () => {
  const project = {
    command_env: {
      unset: ['OLD_VALUE'],
      set: { SHARED: 'literal {{unchanged}}', QUOTED: "it's safe" },
      domains: {
        perps: { set: { LIBRARY: 'perps={{repo}}' } },
      },
    },
  };
  assert.equal(
    buildProjectCommandEnvPrefix(project),
    "unset OLD_VALUE && export SHARED='literal {{unchanged}}' && export QUOTED='it'\\''s safe'",
  );
});

test('domain command_env overlays base values and expands only domain set values', () => {
  const resolved = resolveProjectCommandEnv(
    {
      command_env: {
        unset: ['BASE_UNSET', 'RESTORED'],
        set: { SHARED: 'base', REMOVED: 'base' },
        domains: {
          perps: {
            unset: ['REMOVED'],
            set: { SHARED: 'domain', RESTORED: '{{repo}}/library' },
          },
        },
      },
    },
    {
      domain: 'perps',
      expandDomainValue: (value) => value.replace('{{repo}}', '/worker/repo'),
    },
  );
  assert.deepEqual(resolved, {
    unset: ['BASE_UNSET', 'REMOVED'],
    set: { SHARED: 'domain', RESTORED: '/worker/repo/library' },
  });
});

test('unknown domains apply only base command_env and unresolved domain placeholders fail', () => {
  const project = {
    command_env: {
      set: { SHARED: 'base' },
      domains: { perps: { set: { LIBRARY: '{{repo}}/library' } } },
    },
  };
  assert.deepEqual(resolveProjectCommandEnv(project, { domain: 'other' }), {
    unset: [],
    set: { SHARED: 'base' },
  });
  assert.throws(
    () => resolveProjectCommandEnv(project, { domain: 'perps' }),
    /contains an unresolved placeholder/,
  );
});

test('invalid domain environment names fail before command construction', () => {
  assert.throws(
    () =>
      buildProjectCommandEnvPrefix(
        {
          command_env: {
            domains: { perps: { set: { 'BAD-NAME': 'value' } } },
          },
        },
        { domain: 'perps' },
      ),
    /invalid variable name/,
  );
});

test('machine env exports pool.env values, quoted, ahead of the command', () => {
  assert.equal(
    buildMachineEnvPrefix({ MM_HARNESS_BIN: "/Users/me/it's/mm-harness", OTHER: 'x' }),
    "export MM_HARNESS_BIN='/Users/me/it'\\''s/mm-harness' && export OTHER='x'",
  );
  assert.equal(
    withMachineEnv('cd /repo && claude', { machineEnv: { MM_HARNESS_BIN: '/opt/mm-harness' } }),
    "export MM_HARNESS_BIN='/opt/mm-harness' && cd /repo && claude",
  );
  assert.equal(withMachineEnv('cd /repo && claude', {}), 'cd /repo && claude');
  assert.equal(withMachineEnv('cd /repo && claude', { machineEnv: {} }), 'cd /repo && claude');
});
