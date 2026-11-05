import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { type PrepareRuntimeContextVars, syncPrepareFixtures } from './prepare-runtime-context.js';

const execFileAsync = promisify(execFile);
const supportDir = fileURLToPath(new URL('../../../../../', import.meta.url));

test('prepare refreshes a moved checkout binding through the existing runtime writer', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prepare-runtime-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldRepo = path.join(root, 'old checkout');
  const movedRepo = path.join(root, "moved 'checkout");
  await mkdir(path.join(oldRepo, '.agent'), { recursive: true });
  await writeFile(
    path.join(oldRepo, '.agent/agentic-runtime.json'),
    JSON.stringify({ repoRoot: oldRepo }),
  );
  await rename(oldRepo, movedRepo);
  const alias = path.join(root, 'current checkout');
  await symlink(movedRepo, alias);
  const vars: PrepareRuntimeContextVars = {
    slotId: 'fixture-slot',
    remoteRepo: alias,
    projectName: 'fixture-project',
    machine: 'fixture-machine',
    platform: 'cli',
    resourceVars: { port: '19307', metro_port: '19308' },
  };
  const order: string[] = [];
  await syncPrepareFixtures(vars, {
    runtimeDir: '.agent',
    supportDir,
    sync: async () => {
      order.push('fixtures');
    },
    writeContext: async (command) => {
      order.push('runtime');
      const result = await execFileAsync('bash', ['-c', command]);
      return { ...result, exitCode: 0 };
    },
  });
  const context = JSON.parse(
    await readFile(path.join(movedRepo, '.agent/agentic-runtime.json'), 'utf8'),
  );
  assert.equal(context.repoRoot, await realpath(movedRepo));
  assert.equal(context.slotId, vars.slotId);
  assert.equal(context.watcherPort, 19307);
  assert.equal(context.metroPort, 19308);
  assert.deepEqual(order, ['fixtures', 'runtime']);
});

test('a failed runtime writer fails preparation instead of retaining a stale binding', async () => {
  const vars: PrepareRuntimeContextVars = {
    slotId: 'fixture-slot',
    remoteRepo: '/fixture',
    projectName: 'fixture-project',
    machine: 'fixture-machine',
    platform: 'cli',
    resourceVars: {},
  };
  await assert.rejects(
    syncPrepareFixtures(vars, {
      runtimeDir: '.agent',
      supportDir,
      sync: async () => {},
      writeContext: async () => ({ stdout: '', stderr: 'writer refused', exitCode: 17 }),
    }),
    /writer refused/,
  );
});
