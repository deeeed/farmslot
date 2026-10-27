import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

import type { ProjectVars, SlotVars } from '../../core/index.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'reopen-fixture-'));
const repo = path.join(root, "repo's space");
const runtime = path.join(repo, 'runtime');
const fixtures = path.join(root, 'pack/fixtures');
await mkdir(runtime, { recursive: true });
await mkdir(fixtures, { recursive: true });
after(() => rm(root, { recursive: true, force: true }));

const vars: SlotVars = {
  slotId: 'remote-terminal-1',
  machine: 'remote',
  platform: 'web',
  host: 'remote.invalid',
  sshUser: '',
  osType: 'darwin',
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
  repo,
  remoteRepo: repo,
  session: 'terminal-1',
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: '',
  projectName: 'terminal',
  resourceVars: { cdp_port: '9543', port: '9343' },
  machineEnv: { FARMSLOT_WORKSPACE: path.join(root, 'deployment') },
};
const project: ProjectVars = {
  projectName: 'terminal',
  projectConfig: path.join(root, 'pack/project.json'),
  projectFixturesDir: fixtures,
  projectTemplatesDir: path.join(root, 'pack/templates'),
  runtimeDir: 'runtime',
  artifactDir: 'tasks',
  projectJson: {
    fixtures: { templates: [{ src: 'reopen.sh', dst: '{{runtime_dir}}/reopen-browser.sh' }] },
  },
};
const retained = '#!/bin/bash\necho retired-root >&2\nexit 127\n';
const realCore = await import('../../core/index.js');
const sourceSelections: string[] = [];
mock.module('../../sources/runtime.js', {
  namedExports: {
    withSlotSources: async (slotId: string, operation: () => Promise<unknown>) => {
      sourceSelections.push(slotId);
      return operation();
    },
  },
});
mock.module('../../core/index.js', {
  namedExports: {
    ...realCore,
    loadSlotVars: async () => vars,
    loadProjectVars: async () => project,
    slotFileExists: async (_vars: SlotVars, file: string) => existsSync(file),
    execOnSlot: async (_vars: SlotVars, command: string) => {
      const result = spawnSync('bash', ['-c', command], { encoding: 'utf8', timeout: 2000 });
      if (result.error) throw result.error;
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
    },
  },
});
const { slotReopen } = await import('./helpers.js');

beforeEach(async () => {
  sourceSelections.length = 0;
  await writeFile(path.join(runtime, 'reopen-browser.sh'), retained);
  await writeFile(
    path.join(fixtures, 'reopen.sh'),
    [
      '#!/bin/bash',
      'printf "root=%s\\n" "{{farmslot_dir}}"',
      'printf "directory=%s\\n" "$(dirname "${BASH_SOURCE[0]}")"',
      'printf "arg=%s\\n" "$@"',
    ].join('\n'),
  );
});

test('reopen renders the selected fixture with the current remote workspace, retaining the saved wrapper', async () => {
  const result = await slotReopen({ slotId: vars.slotId }, () => {});
  assert.deepEqual(sourceSelections, [vars.slotId]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`root=${vars.machineEnv?.FARMSLOT_WORKSPACE}`));
  assert.ok(result.stdout.includes(`directory=${runtime}\n`));
  assert.ok(result.stdout.includes(`arg=${vars.slotId}\n`));
  assert.ok(result.stdout.includes('arg=9543\n'));
  assert.ok(result.stdout.includes('arg=9343\n'));
  assert.equal(await readFile(path.join(runtime, 'reopen-browser.sh'), 'utf8'), retained);
  assert.deepEqual(await readdir(runtime), ['reopen-browser.sh']);
});

test('a failed selected launcher keeps its exit code and removes its temporary script', async () => {
  await writeFile(path.join(fixtures, 'reopen.sh'), 'echo selected-failure >&2\nexit 42\n');
  const result = await slotReopen({ slotId: vars.slotId }, () => {});
  assert.equal(result.exitCode, 42);
  assert.equal(result.stderr.trim(), 'selected-failure');
  assert.deepEqual(await readdir(runtime), ['reopen-browser.sh']);
  assert.equal(await readFile(path.join(runtime, 'reopen-browser.sh'), 'utf8'), retained);
});

test('an explicit runtime override still executes its retained launcher', async () => {
  const custom = path.join(repo, 'custom');
  await mkdir(custom, { recursive: true });
  await writeFile(path.join(custom, 'reopen-browser.sh'), 'echo explicit-runtime\n');
  const result = await slotReopen({ slotId: vars.slotId, runtimeDir: 'custom' }, () => {});
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'explicit-runtime');
});

test('a missing declared source fails without running the stale retained launcher', async () => {
  await rm(path.join(fixtures, 'reopen.sh'));
  await assert.rejects(
    slotReopen({ slotId: vars.slotId }, () => {}),
    /ENOENT/,
  );
});
