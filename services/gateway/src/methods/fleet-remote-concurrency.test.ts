import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { FleetStatusResult } from '@farmslot/protocol';

import type { ProjectVars } from '../core/config.js';
import { withSlotCommandExecutor } from '../core/exec-scope.js';
import { makeVars } from '../runners/test-fixtures.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-remote-concurrency-'));
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
await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated remote health fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(path.join(root, 'status.json'), '{"slots":[]}\n');
const ids = Array.from({ length: 9 }, (_, i) => `remote-${i}`);
await writeFile(
  path.join(root, 'pool/remote.json'),
  JSON.stringify({
    machine: 'remote-proof',
    host: 'remote-proof.invalid',
    platform: 'cli',
    project: 'proof',
    slots: ids.map((id) => ({ id, session: id, repo: `/repos/${id}`, enabled: true })),
  }),
);
const project: ProjectVars = {
  projectName: 'proof',
  projectConfig: path.join(root, 'projects/proof/project.json'),
  projectFixturesDir: path.join(root, 'projects/proof/fixtures'),
  projectTemplatesDir: path.join(root, 'projects/proof/templates'),
  runtimeDir: '.agent',
  artifactDir: '.task',
  projectJson: { name: 'proof', default_branch: 'main' },
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
        repo: `/repos/${slotId}`,
        remoteRepo: `/repos/${slotId}`,
        resourceVars: { platform: 'cli', slot_id: slotId },
      }),
    loadProjectVars: async () => project,
  },
});
const { fleetHealthRefresh } = await import('./fleet.js');

test('remote health checks admit four slots, preserve order, and never exceed the shared bound', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let active = 0;
  let peak = 0;
  let block = true;
  const release: Array<() => void> = [];
  let entered: () => void = () => assert.fail('Probe signal missing');
  const firstProbe = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const running = withSlotCommandExecutor(
    async (_vars, command) => {
      if (!command.includes('farmslot-probe.')) return { exitCode: 0, stdout: '', stderr: '' };
      active++;
      peak = Math.max(peak, active);
      entered();
      try {
        if (block) await new Promise<void>((resolve) => release.push(resolve));
        return { exitCode: 0, stdout: '', stderr: '' };
      } finally {
        active--;
      }
    },
    () => fleetHealthRefresh(),
  );
  await firstProbe;
  for (let turn = 0; turn < 10 && peak < 4; turn++) await Promise.resolve();
  let result: FleetStatusResult | undefined;
  try {
    assert.equal(peak, 4, 'A slow first slot must not serialize every sibling');
  } finally {
    block = false;
    for (const finish of release) finish();
    result = await running;
  }
  assert.ok(result);
  assert.deepEqual(
    result.fleet.slots.map((slot) => slot.slot),
    ids,
  );
  assert.equal(active, 0);
  assert.equal(peak, 4);
});
