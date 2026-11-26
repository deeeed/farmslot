// A remote slot whose health hook calls a farm script, refreshed while its support bundle is still
// being delivered: the hook's batch answers "pending" with no output, as execOnSlot does, and the
// row must still carry the checkout's branch and commit.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { promisify } from 'node:util';

import type { ProjectVars } from '../core/config.js';
import { withSlotCommandExecutor } from '../core/exec-scope.js';
import { makeVars } from '../runners/test-fixtures.js';

const run = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-probe-support-pending-'));
after(() => rm(root, { recursive: true, force: true }));
for (const dir of ['pool', 'projects/proof', 'scripts', 'services/gateway', 'runs', 'home'])
  await mkdir(path.join(root, dir), { recursive: true });
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated pending-bundle fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(path.join(root, 'status.json'), '{"slots":[]}\n');

// A real checkout on main, so the git probes have something to read.
const repo = path.join(root, 'checkout');
await mkdir(repo);
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one');
const headSha = git('rev-parse', 'HEAD');

await writeFile(
  path.join(root, 'pool/remote.json'),
  JSON.stringify({
    machine: 'remote-proof',
    host: 'remote-proof.invalid',
    platform: 'cli',
    project: 'proof',
    slots: [{ id: 'remote-0', session: 'remote-0', repo, enabled: true }],
  }),
);
const project: ProjectVars = {
  projectName: 'proof',
  projectConfig: path.join(root, 'projects/proof/project.json'),
  projectFixturesDir: path.join(root, 'projects/proof/fixtures'),
  projectTemplatesDir: path.join(root, 'projects/proof/templates'),
  runtimeDir: '.agent',
  artifactDir: '.task',
  projectJson: {
    name: 'proof',
    default_branch: 'main',
    hooks: { health_check: 'bash {{farmslot_dir}}/projects/proof/setup/health-check.sh' },
  },
};
await writeFile(project.projectConfig, JSON.stringify(project.projectJson));
await import('../runtime/mock-pty.test-support.js');
const core = await import('../core/index.js');
mock.module('../core/index.js', {
  namedExports: {
    ...core,
    loadSlotVars: async (slotId: string) =>
      makeVars({
        slotId,
        session: slotId,
        machine: 'remote-proof',
        host: 'remote-proof.invalid',
        platform: 'cli',
        projectName: 'proof',
        repo,
        remoteRepo: repo,
        resourceVars: { platform: 'cli', slot_id: slotId },
      }),
    loadProjectVars: async () => project,
  },
});
const { fleetHealthRefresh } = await import('./fleet.js');

test('a pending support bundle does not erase a remote slot branch and commit', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const batches: string[] = [];
  const result = await withSlotCommandExecutor(
    async (_vars, command) => {
      if (!command.includes('farmslot-probe.')) return { exitCode: 0, stdout: '', stderr: '' };
      batches.push(command);
      // execOnSlot's answer while the bundle a farm script needs is still being delivered.
      if (command.includes('farmslot-node/projects/proof/setup/health-check.sh'))
        return { exitCode: 124, stdout: '', stderr: 'node support bundle still being delivered' };
      const { stdout } = await run('/bin/sh', ['-c', command]);
      return { exitCode: 0, stdout, stderr: '' };
    },
    () => fleetHealthRefresh(),
  );
  assert.equal(batches.length, 2, 'the farm-script hook runs in its own batch');
  const row = result.fleet.slots.find((slot) => slot.slot === 'remote-0');
  assert.equal(row?.branch, 'main');
  assert.equal(row?.headSha, headSha);
});
