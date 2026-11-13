import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// Config paths are captured at import. Each test file runs in its own process.
const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'support-pool-reads-')));
after(() => rm(home, { recursive: true, force: true }));
const pool = path.join(home, 'pool');
const projects = path.join(home, 'projects');
const runs = path.join(home, 'runs');
process.env.FARMSLOT_POOL_DIR = pool;
process.env.FARMSLOT_PROJECTS_DIR = projects;
process.env.FARMSLOT_RUNS_DIR = runs;
const { loadSlotVars } = await import('@farmslot/slot-config');
// The run store first, as the gateway loads it: activation.js alone meets an import cycle.
await import('../runs/store.js');
const { nodeSupportRetentionReferences } = await import('./activation.js');

test('the retention inventory reads the pool directory once for all of its slots', async (t) => {
  await Promise.all([
    mkdir(pool),
    mkdir(runs),
    mkdir(path.join(projects, 'fixture'), { recursive: true }),
  ]);
  const slotIds = ['fixture-1', 'fixture-2', 'fixture-3', 'fixture-4'];
  await writeFile(
    path.join(pool, 'fixture.json'),
    JSON.stringify({
      machine: 'fixture',
      host: 'fixture.invalid',
      ssh_user: 'fixture',
      os: 'macos',
      platform: 'cli',
      project: 'fixture',
      slots: slotIds.map((id) => ({ id, repo: path.join(home, id), session: id })),
    }),
  );
  await writeFile(
    path.join(projects, 'fixture', 'project.json'),
    JSON.stringify({ name: 'fixture' }),
  );
  const vars = await loadSlotVars('fixture-1');

  const { statSync } = fs;
  let poolDirectoryStats = 0;
  t.mock.method(fs, 'statSync', (...args: Parameters<typeof statSync>) => {
    if (String(args[0]) === pool) poolDirectoryStats += 1;
    return statSync(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const references = await nodeSupportRetentionReferences(vars);
  assert.equal(references.selectionPaths.length, slotIds.length);
  assert.equal(poolDirectoryStats, 1, 'one pool read, not one per slot');
});
