import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { archiveOrphanSlotScaffolding } from './orphan-scaffolding.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-24T12:00:00Z');

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orphan-scaffolding-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scaffoldingRoot = path.join(root, 'runs/slot-scaffolding');
  const archiveRoot = path.join(root, 'archive');
  await fs.mkdir(archiveRoot, { recursive: true });
  /** A collection as slot release writes it: the tars first, manifest.json last. */
  const collection = async (
    slot: string,
    id: string,
    ageDays: number,
    { complete = true }: { complete?: boolean } = {},
  ) => {
    const dir = path.join(scaffoldingRoot, slot, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'scaffolding.tar'), `tar of ${id}`);
    if (complete) {
      const manifest = path.join(dir, 'manifest.json');
      await fs.writeFile(manifest, JSON.stringify({ slotId: slot, sources: [], skipped: [] }));
      const at = new Date(NOW - ageDays * DAY);
      await fs.utimes(manifest, at, at);
    }
    return dir;
  };
  return { root, scaffoldingRoot, archiveRoot, collection };
}

test('a complete orphan collection older than the window moves to the archive with a restore manifest', async (t) => {
  const { scaffoldingRoot, archiveRoot, collection } = await fixture(t);
  const old = await collection('macwork-mmt-3', '4d5e3092-01a2-4822-86dd-4f6a61570dd5', 30);

  const result = await archiveOrphanSlotScaffolding({
    scaffoldingRoot,
    archiveRoot,
    maxAgeMs: 7 * DAY,
    now: NOW,
  });

  assert.equal(result.skipped, undefined);
  assert.deepEqual(
    result.archived.map((entry) => entry.source),
    [old],
  );
  assert.ok(result.archived[0].bytes > 0);
  await assert.rejects(fs.stat(old), /ENOENT/);
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(archiveRoot, 'slot-scaffolding-macwork-mmt-3/manifest.json'),
      'utf8',
    ),
  );
  const [entry] = manifest.entries;
  assert.equal(entry.source, old);
  assert.equal(entry.store, 'slot-scaffolding');
  assert.equal(entry.state, 'archived');
  assert.equal(
    await fs.readFile(path.join(entry.destination, 'scaffolding.tar'), 'utf8'),
    'tar of 4d5e3092-01a2-4822-86dd-4f6a61570dd5',
  );
});

test('young and incomplete collections stay where they are', async (t) => {
  const { scaffoldingRoot, archiveRoot, collection } = await fixture(t);
  const young = await collection('mini-mm-1', 'b4127917-91b2-4eea-a3c1-85faf17b2907', 2);
  // No manifest.json: a release still collecting it, or one that failed mid-copy.
  const partial = await collection('mini-mm-1', '2f8cf61c-a330-4619-a4a5-a62d55ebb50b', 30, {
    complete: false,
  });
  const result = await archiveOrphanSlotScaffolding({
    scaffoldingRoot,
    archiveRoot,
    maxAgeMs: 7 * DAY,
    now: NOW,
  });
  assert.deepEqual(result.archived, []);
  await fs.stat(young);
  await fs.stat(partial);
});

test('an unavailable archive root skips the move and reports it instead of failing', async (t) => {
  const { root, scaffoldingRoot, collection } = await fixture(t);
  const old = await collection('macwork-mmt-3', '4ba84adb-90fd-49fb-9359-834217cb63e7', 30);
  const unmounted = path.join(root, 'Volumes/c910ssd/farmslot-data/run-archive');

  const result = await archiveOrphanSlotScaffolding({
    scaffoldingRoot,
    archiveRoot: unmounted,
    maxAgeMs: 7 * DAY,
    now: NOW,
  });

  assert.deepEqual(result.archived, []);
  assert.match(result.skipped ?? '', /run-archive/);
  assert.equal(result.pending, 1);
  await fs.stat(path.join(old, 'scaffolding.tar'));
});

test('no scaffolding store is nothing to do', async (t) => {
  const { root, archiveRoot } = await fixture(t);
  const result = await archiveOrphanSlotScaffolding({
    scaffoldingRoot: path.join(root, 'absent'),
    archiveRoot,
    maxAgeMs: 7 * DAY,
    now: NOW,
  });
  assert.deepEqual(result, { archived: [], pending: 0, failed: [] });
});
