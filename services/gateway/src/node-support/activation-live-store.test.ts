import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// Config paths are captured at import. Each test file runs in its own process.
const home = await mkdtemp(path.join(os.tmpdir(), 'support-live-inventory-'));
after(() => rm(home, { recursive: true, force: true }));
const pool = path.join(home, 'pool');
const projects = path.join(home, 'projects');
const runs = path.join(home, 'runs');
process.env.FARMSLOT_POOL_DIR = pool;
process.env.FARMSLOT_PROJECTS_DIR = projects;
process.env.FARMSLOT_RUNS_DIR = runs;
const { makeRun } = await import('../run-engine/test-fixtures.js');
const { loadSlotVars } = await import('@farmslot/slot-config');
const { getRun, loadAllRuns, persistRunNow } = await import('../runs/store.js');
const { nodeSupportRetentionReferences } = await import('./activation.js');

const hash = (letter: string) => letter.repeat(64);
const record = (id: string, letter: string) =>
  JSON.stringify(
    makeRun({
      id,
      status: 'done',
      slotId: 'fixture-1',
      steps: [{ name: 'prepare', status: 'done', outputs: { nodeSupportHash: hash(letter) } }],
    }),
  );

test('a gateway inventory reads live runs from memory and other runs from disk', async () => {
  await Promise.all([
    mkdir(pool),
    mkdir(runs),
    mkdir(path.join(projects, 'fixture'), { recursive: true }),
  ]);
  await writeFile(
    path.join(pool, 'fixture.json'),
    JSON.stringify({
      machine: 'fixture',
      host: 'fixture.invalid',
      ssh_user: 'fixture',
      os: 'macos',
      platform: 'cli',
      project: 'fixture',
      slots: [{ id: 'fixture-1', repo: path.join(home, 'slot'), session: 'fixture-1' }],
    }),
  );
  await writeFile(
    path.join(projects, 'fixture', 'project.json'),
    JSON.stringify({ name: 'fixture', paths: { runtime_dir: 'temp/farmslot' } }),
  );
  await writeFile(path.join(runs, 'live.json'), record('live', 'a'));
  // The gateway loads its runs from disk at startup.
  await loadAllRuns();
  const vars = await loadSlotVars('fixture-1');
  assert.deepEqual((await nodeSupportRetentionReferences(vars)).runHashes, [hash('a')]);

  const live = getRun('live');
  assert.ok(live);
  // Settles any load-time write first, so nothing rewrites the file below.
  await persistRunNow(live);
  // The live record wins over its file, so the file is not read: even a corrupt one.
  await writeFile(path.join(runs, 'live.json'), '{');
  // A record another process wrote is not in memory, so it is still read from disk.
  await writeFile(path.join(runs, 'foreign.json'), record('foreign', 'b'));
  // Edited in memory and not yet persisted: the in-memory record is the one scanned.
  live.steps[0].outputs = { nodeSupportHash: hash('c') };
  const references = await nodeSupportRetentionReferences(vars);
  assert.deepEqual(references.runHashes.sort(), [hash('b'), hash('c')]);
  assert.deepEqual(references.runInventory?.runIds.sort(), ['foreign', 'live']);

  // A corrupt record nothing in memory owns still refuses the inventory.
  await writeFile(path.join(runs, 'foreign.json'), '{');
  await assert.rejects(nodeSupportRetentionReferences(vars));
});
