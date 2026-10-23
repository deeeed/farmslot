import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// Config paths are captured at import. Each test file runs in its own process.
const home = await mkdtemp(path.join(os.tmpdir(), 'support-run-inventory-'));
after(() => rm(home, { recursive: true, force: true }));
const pool = path.join(home, 'pool');
const projects = path.join(home, 'projects');
const runs = path.join(home, 'runs');
process.env.FARMSLOT_POOL_DIR = pool;
process.env.FARMSLOT_PROJECTS_DIR = projects;
process.env.FARMSLOT_RUNS_DIR = runs;
const { makeRun } = await import('../run-engine/test-fixtures.js');
const { loadSlotVars } = await import('@farmslot/slot-config');
const { listRuns } = await import('../runs/store.js');
const { nodeSupportRetentionReferences } = await import('./activation.js');

test('one-shot inventory finds active fixture ownership on disk with an empty run store', async () => {
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
    JSON.stringify({
      name: 'fixture',
      paths: { runtime_dir: 'temp/farmslot' },
      fixtures: {
        templates: [{ src: 'ci-parity', dst: '{{runtime_dir}}/ci-parity' }],
        directories: [{ src: 'policy', dst: 'temp/policy' }],
      },
    }),
  );
  await writeFile(
    path.join(runs, 'active.json'),
    JSON.stringify(
      makeRun({
        id: 'active',
        status: 'blocked',
        slotId: null,
        steps: [{ name: 'find-slot', status: 'done', outputs: { selectedSlot: 'fixture-1' } }],
      }),
    ),
  );
  await writeFile(
    path.join(runs, 'ended.json'),
    JSON.stringify(makeRun({ id: 'ended', status: 'done', slotId: 'fixture-1' })),
  );
  await writeFile(
    path.join(runs, 'runtime-capabilities-7777.json'),
    JSON.stringify({ schemaVersion: 1, capabilities: [] }),
  );
  await mkdir(path.join(runs, 'archive'));
  await writeFile(
    path.join(runs, 'archive/archived-owner.json'),
    JSON.stringify({
      ...makeRun({ id: 'archived-owner', status: 'done' }),
      archivedAt: '2026-10-23T00:00:00Z',
    }),
  );
  assert.equal(listRuns().runs.length, 0);
  const references = await nodeSupportRetentionReferences(await loadSlotVars('fixture-1'));
  assert.deepEqual(references.activeRuns, [
    {
      runId: 'active',
      paths: [
        path.join(home, '.farmslot-runtime/slot/temp/farmslot/.observability/node-support-hash'),
        path.join(home, 'slot/temp/farmslot/ci-parity'),
        path.join(home, 'slot/temp/policy'),
      ],
    },
  ]);
  assert.deepEqual(references.endedRunIds, ['archived-owner', 'ended']);
  assert.deepEqual(references.runInventory?.runIds, ['archived-owner', 'active', 'ended']);
  const next = await Promise.all([
    nodeSupportRetentionReferences(await loadSlotVars('fixture-1')),
    nodeSupportRetentionReferences(await loadSlotVars('fixture-1')),
  ]);
  assert.equal(references.runInventory?.generation, '1');
  assert.equal(references.runInventory?.capturedThrough, '2');
  assert.deepEqual(
    next
      .flatMap((value) => [value.runInventory?.generation, value.runInventory?.capturedThrough])
      .sort(),
    ['3', '4', '5', '6'],
  );
  for (const value of next) {
    assert.ok(value.runInventory);
    assert.ok(BigInt(value.runInventory.capturedThrough) > BigInt(value.runInventory.generation));
  }
});
