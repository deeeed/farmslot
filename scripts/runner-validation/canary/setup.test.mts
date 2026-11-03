import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { selectExecutionTemplate } from '../../../packages/agent-runtime/src/execution-template/select.js';
import { resolveConfiguredExecutionTemplateSources } from '../../../packages/agent-runtime/src/execution-template/source-config.js';
import type { ProjectExecutionTemplatesConfig } from '../../../packages/protocol/src/index.js';
import { validatePackPortability } from '../../../packages/protocol/src/node/pack-portability.js';

import { projectPacks } from './fixtures.mjs';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const json = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};

test('setup emits a portable pack and preserves the node installation environment and templates', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'canary-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const farm = path.join(root, 'farm');
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const config: { live: { nodes: { machine: string; slot: string }[] } } = JSON.parse(
    readFileSync(new URL('./config.json', import.meta.url), 'utf8'),
  );
  const homes: Record<string, string> = {};
  for (const node of config.live.nodes) {
    const home = path.join(root, node.machine);
    homes[`${node.machine}.invalid`] = home;
    const workspace = path.join(home, 'node-install');
    json(path.join(farm, 'pool', `${node.machine}.json`), {
      machine: node.machine,
      host: `${node.machine}.invalid`,
      project: 'example',
      env: {
        FARMSLOT_WORKSPACE: workspace,
        FARMSLOT_POOL_DIR: path.join(workspace, 'pool'),
        FARMSLOT_PROJECTS_DIR: path.join(workspace, 'projects'),
        CANARY_TOOL_ROOT: path.join(home, 'tools'),
      },
    });
  }
  writeFileSync(
    path.join(bin, 'ssh'),
    `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const homes=${JSON.stringify(homes)};
const args=process.argv.slice(2); let i=0;
while(args[i]?.startsWith('-')) i+=2;
const home=homes[args[i]]; if(!home) throw Error('unexpected SSH target');
const result=spawnSync(args[i+1],args.slice(i+2),{stdio:'inherit',env:{...process.env,HOME:home}});
process.exit(result.status??1);
`,
    { mode: 0o755 },
  );
  const setup = (apply: boolean) => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(source, 'scripts/runner-validation/canary/setup.mts'),
        '--farm',
        farm,
        ...(apply ? ['--apply'] : []),
      ],
      {
        cwd: source,
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          TSX_TSCONFIG_PATH: path.join(source, 'services/gateway/tsconfig.json'),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
  };
  setup(false);
  assert.equal(existsSync(path.join(farm, 'projects')), false);
  for (const home of Object.values(homes))
    assert.equal(existsSync(path.join(home, 'farmslot-canary')), false);
  setup(true);
  const projectDir = path.join(farm, 'projects/farmslot-canary');
  const project: {
    repo_url?: string;
    hooks?: { post_merge_install?: string };
    execution_templates?: ProjectExecutionTemplatesConfig;
  } = JSON.parse(readFileSync(path.join(projectDir, 'project.json'), 'utf8'));
  await t.test('a local per-node origin never becomes the portable project repo identity', () => {
    assert.equal(project.repo_url, undefined);
    assert.deepEqual(validatePackPortability(projectDir), []);
  });
  await t.test('the dependency-free repository explicitly needs no install', () => {
    assert.equal(project.hooks?.post_merge_install, 'true');
  });
  await t.test('each generated pool retains its configured node installation environment', () => {
    for (const node of config.live.nodes) {
      const original = JSON.parse(
        readFileSync(path.join(farm, 'pool', `${node.machine}.json`), 'utf8'),
      );
      const canary = JSON.parse(
        readFileSync(path.join(farm, 'pool', `canary-${node.machine}.json`), 'utf8'),
      );
      assert.deepEqual(canary.env, original.env);
      assert.equal(canary.slots[0].id, node.slot);
    }
  });
  await t.test(
    'the deployment template boundary contains the workspace source on every node',
    () => {
      for (const home of Object.values(homes)) {
        const deployed = path.join(home, 'node-install/projects/farmslot-canary');
        mkdirSync(deployed, { recursive: true });
        cpSync(path.join(projectDir, 'project.json'), path.join(deployed, 'project.json'));
        cpSync(path.join(projectDir, 'templates'), path.join(deployed, 'templates'), {
          recursive: true,
        });
        const resolved = resolveConfiguredExecutionTemplateSources(project.execution_templates, {
          projectPackRoot: deployed,
        });
        assert.deepEqual(resolved.unavailable, []);
        assert.equal(resolved.sources.length, 1);
      }
    },
  );
  const original = readFileSync(path.join(projectDir, 'project.json'));
  writeFileSync(path.join(projectDir, 'keep-local'), 'keep');
  setup(true);
  assert.deepEqual(readFileSync(path.join(projectDir, 'project.json')), original);
  assert.equal(readFileSync(path.join(projectDir, 'keep-local'), 'utf8'), 'keep');
});

test('restart matrix packs preserve their shared template IDs in the deployment layout', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'canary-matrix-layout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const pack of projectPacks(path.join(root, 'holds'))) {
    const dir = path.join(root, pack.name);
    for (const [file, content] of Object.entries(pack.files)) {
      if (!file.startsWith('templates/')) continue;
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), content);
    }
    json(path.join(dir, 'project.json'), pack.projectJson);
    const project: { execution_templates?: ProjectExecutionTemplatesConfig } = JSON.parse(
      readFileSync(path.join(dir, 'project.json'), 'utf8'),
    );
    const resolved = resolveConfiguredExecutionTemplateSources(project.execution_templates, {
      projectPackRoot: dir,
    });
    assert.deepEqual(resolved.unavailable, []);
    for (const flow of ['dev', 'validation']) {
      const selected = selectExecutionTemplate({
        sources: resolved.sources,
        flow,
        platform: 'cli',
        explicitId: `${flow}/shared`,
      });
      assert.equal(selected.entry.id, `${flow}/shared`);
      assert.equal(selected.entry.sourceId, 'workspace:shared');
    }
  }
});

test('nightly installation clones from a linked worktree without relying on its object store', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'canary-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, 'seed');
  const linked = path.join(root, 'linked');
  const checkout = path.join(root, 'nightly');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  mkdirSync(seed);
  mkdirSync(home);
  mkdirSync(bin);
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: seed, env, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  for (const file of ['install-nightly.sh', 'com.farmslot.canary-nightly.plist']) {
    mkdirSync(path.join(seed, 'scripts/runner-validation/canary'), { recursive: true });
    cpSync(
      path.join(source, 'scripts/runner-validation/canary', file),
      path.join(seed, 'scripts/runner-validation/canary', file),
    );
  }
  git('add', '.');
  git(
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'test: seed canary installer',
  );
  git('clone', '-q', '--bare', seed, path.join(root, 'origin.git'));
  git('remote', 'add', 'origin', path.join(root, 'origin.git'));
  git('worktree', 'add', '--detach', linked);
  writeFileSync(
    path.join(bin, 'launchctl'),
    '#!/bin/sh\ncase "$1" in print) exit 1;; bootstrap) exit 0;; *) exit 2;; esac\n',
    { mode: 0o755 },
  );
  writeFileSync(path.join(bin, 'plutil'), '#!/bin/sh\n[ "$1" = "-lint" ] && [ -f "$2" ]\n', {
    mode: 0o755,
  });
  const result = spawnSync(
    'bash',
    [
      path.join(linked, 'scripts/runner-validation/canary/install-nightly.sh'),
      '--checkout',
      checkout,
      '--home',
      path.join(root, 'evidence'),
    ],
    { env, encoding: 'utf8', timeout: 20_000 },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(existsSync(path.join(checkout, '.git')));
  assert.equal(existsSync(path.join(checkout, '.git/objects/info/alternates')), false);
});
