import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { mock, type TestContext } from 'node:test';

import { archiveOrphanSlotScaffolding } from './orphan-scaffolding.js';
import { resumeStorageArchives } from './storage-archive.js';

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

test(
  'an archive root on an unmounted volume skips the move and reports it instead of failing',
  { skip: process.platform !== 'darwin' && 'the mount check reads /Volumes' },
  async (t) => {
    const { scaffoldingRoot, collection } = await fixture(t);
    const old = await collection('macwork-mmt-3', '4ba84adb-90fd-49fb-9359-834217cb63e7', 30);
    const unmounted = `/Volumes/farmslot-test-${randomUUID()}/farmslot-data/run-archive`;

    const result = await archiveOrphanSlotScaffolding({
      scaffoldingRoot,
      archiveRoot: unmounted,
      maxAgeMs: 7 * DAY,
      now: NOW,
    });

    assert.deepEqual(result.archived, []);
    assert.match(result.skipped ?? '', /is not mounted/);
    assert.equal(result.pending, 1);
    await fs.stat(path.join(old, 'scaffolding.tar'));
  },
);

test('a missing archive root skips the move and reports it instead of failing', async (t) => {
  const { root, scaffoldingRoot, collection } = await fixture(t);
  const old = await collection('macwork-mmt-3', '4ba84adb-90fd-49fb-9359-834217cb63e7', 30);

  const result = await archiveOrphanSlotScaffolding({
    scaffoldingRoot,
    archiveRoot: path.join(root, 'missing/run-archive'),
    maxAgeMs: 7 * DAY,
    now: NOW,
  });

  assert.deepEqual(result.archived, []);
  assert.match(result.skipped ?? '', /missing\/run-archive/);
  assert.equal(result.pending, 1);
  await fs.stat(path.join(old, 'scaffolding.tar'));
});

test('an interrupted move is reported, never staged again, and resumes to its original source', async (t) => {
  const { scaffoldingRoot, archiveRoot, collection } = await fixture(t);
  const old = await collection('macwork-mmt-3', '4a60ad57-d80b-4516-a32b-31f36433613c', 30);
  const rename = fs.rename;
  const copy = fs.cp;
  let interrupted = true;
  // The archive is on another volume: the staged tree is copied, and the copy fails.
  mock.method(fs, 'rename', async (...[from, to]: Parameters<typeof fs.rename>) => {
    if (path.basename(String(from)).startsWith('.retention-'))
      throw Object.assign(new Error('external volume'), { code: 'EXDEV' });
    return rename(from, to);
  });
  mock.method(fs, 'cp', async (...[from, to, options]: Parameters<typeof fs.cp>) => {
    if (interrupted) throw new Error('external drive disconnected');
    return copy(from, to, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  const pass = () =>
    archiveOrphanSlotScaffolding({ scaffoldingRoot, archiveRoot, maxAgeMs: 7 * DAY, now: NOW });
  const manifestFile = path.join(archiveRoot, 'slot-scaffolding-macwork-mmt-3/manifest.json');
  const entries = async () => JSON.parse(await fs.readFile(manifestFile, 'utf8')).entries;

  const first = await pass();
  assert.deepEqual(first.archived, []);
  assert.equal(first.pending, 1);
  assert.match(first.failed[0], /slot-scaffolding-macwork-mmt-3\/manifest\.json: .*disconnected/);
  const [staged] = await entries();
  assert.equal(staged.source, old);
  await fs.stat(staged.staged);

  // The staged sibling has the old manifest.json too; it is not a collection.
  assert.deepEqual(await pass(), { archived: [], pending: 0, failed: [] });
  assert.equal((await entries()).length, 1);

  interrupted = false;
  assert.deepEqual(await resumeStorageArchives(archiveRoot), []);
  const [entry] = await entries();
  assert.equal(entry.source, old);
  assert.equal(entry.state, 'archived');
  assert.equal(
    await fs.readFile(path.join(entry.destination, 'scaffolding.tar'), 'utf8'),
    'tar of 4a60ad57-d80b-4516-a32b-31f36433613c',
  );
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
