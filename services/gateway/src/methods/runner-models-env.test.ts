import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, mock, test } from 'node:test';

import type { ProjectVars } from '../core/config.js';
import { withSlotCommandExecutor } from '../core/exec-scope.js';
import { parsePiModelList, type RunnerModelCatalogNodeSource } from '../runners/model-catalog.js';
import { makeVars } from '../runners/test-fixtures.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'catalog worker env ')));
after(() => rmSync(root, { recursive: true, force: true }));
const binary = join(root, "pi's fixture");
writeFileSync(
  binary,
  `#!${process.execPath}
if (process.argv[2] !== '--list-models') process.exit(2);
console.log(JSON.stringify({
  key: process.env.LITELLM_API_KEY,
  disabled: [process.env.DISABLE_OMC, process.env.DISABLE_OMX],
  login: process.env.F383_LOGIN_SHELL,
  cwd: process.cwd(),
  path: process.env.PATH.split(':').slice(0, 2),
}));
`,
  { mode: 0o755 },
);
const bashEnv = join(root, 'bash-env');
writeFileSync(bashEnv, 'if shopt -q login_shell; then export F383_LOGIN_SHELL=yes; fi\n');
const slots = ['local', 'remote'].map((location) => {
  const repo = join(root, location);
  mkdirSync(join(repo, 'shims'), { recursive: true });
  return makeVars({
    slotId: location,
    machine: `catalog-${location}`,
    host: location === 'local' ? 'localhost' : 'catalog.invalid',
    repo,
    remoteRepo: repo,
    piPath: binary,
    projectName: 'catalog-fixture',
    domain: 'perps',
    machineEnv: {},
  });
});
const project: ProjectVars = {
  projectName: 'catalog-fixture',
  projectConfig: join(root, 'project.json'),
  projectFixturesDir: root,
  projectTemplatesDir: root,
  projectJson: {},
  runtimeDir: '.agent',
  artifactDir: '.agent/artifacts',
};
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async (id: string) => {
      const vars = slots.find((slot) => slot.slotId === id);
      assert.ok(vars);
      return vars;
    },
    loadProjectVars: async (name: string) => {
      assert.equal(name, project.projectName);
      return project;
    },
  },
});
const execution = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...execution,
    // The scoped executor below owns both transports; no node or tmux is contacted.
    isDisconnectedRemote: () => false,
  },
});
const state = await import('../fleet/state.js');
mock.module('../fleet/state.js', {
  namedExports: {
    ...state,
    loadPoolConfigs: async () =>
      slots.map((vars) => ({
        machine: vars.machine,
        slots: [{ id: vars.slotId }],
      })),
  },
});
const { modelCatalogNodes } = await import('./runner-models.js');
const source: RunnerModelCatalogNodeSource = {
  nodeCommand: 'pi',
  slotPathKey: 'piPath',
  args: ['--list-models'],
  parse: parsePiModelList,
};

for (const location of ['local', 'remote']) {
  for (const layer of ['project', 'domain', 'pool', 'unset']) {
    test(`${location} model listing uses the worker's ${layer} environment, login shell and cwd`, async () => {
      const vars = slots.find((slot) => slot.slotId === location)!;
      project.projectJson = {
        command_env: {
          set: {
            ASDF_DATA_DIR: vars.remoteRepo,
            ...(layer === 'unset' ? {} : { LITELLM_API_KEY: 'project-key' }),
          },
          ...(layer === 'domain'
            ? {
                domains: { perps: { set: { LITELLM_API_KEY: 'domain-key' } } },
              }
            : {}),
          ...(layer === 'unset' ? { unset: ['LITELLM_API_KEY'] } : {}),
        },
      };
      vars.machineEnv = layer === 'pool' ? { LITELLM_API_KEY: 'pool-key' } : {};
      await withSlotCommandExecutor(
        async (_selected, command, options) => ({
          stdout: execFileSync('bash', ['-c', command], {
            cwd: options.cwd,
            env: {
              HOME: root,
              PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
              BASH_ENV: bashEnv,
              ...(layer === 'unset' ? { LITELLM_API_KEY: 'inherited-key' } : {}),
            },
            encoding: 'utf8',
          }),
          stderr: '',
          exitCode: 0,
        }),
        async () => {
          const node = (await modelCatalogNodes()).find((node) => node.machine === vars.machine)!;
          const actual: unknown = JSON.parse(await node.list(source));
          assert.deepEqual(actual, {
            ...(layer === 'unset' ? {} : { key: `${layer}-key` }),
            disabled: ['1', '1'],
            login: 'yes',
            cwd: vars.remoteRepo,
            path: [join(root, '.local/bin'), join(vars.remoteRepo, 'shims')],
          });
        },
      );
    });
  }
}
