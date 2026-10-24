import assert from 'node:assert/strict';
import { type FSWatcher, watch } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { GatewayMethodError } from '../core/method-error.js';
import { GatewayResourceRevisions } from '../resources/revisions.js';

import { watchRoadmapItems } from './watcher.js';

const home = await mkdtemp(path.join(os.tmpdir(), 'roadmap-observed-reads-'));
process.env.FARMSLOT_ROADMAP_DIR = path.join(home, 'roadmap');
process.env.FARMSLOT_BACKLOG_FILE = path.join(home, 'backlog.json');
process.env.FARMSLOT_DISPATCH_QUEUE_FILE = path.join(home, 'queue.json');
process.env.FARMSLOT_WORK_GRAPH_DIR = path.join(home, 'graphs');
process.env.FARMSLOT_RUNS_DIR = path.join(home, 'runs');
const store = await import('./store.js');
test.after(() => rm(home, { recursive: true, force: true }));

function item(title: string): string {
  return `---\nid: "ri_observed_file"\nkind: "roadmap-item"\nproject: "unassigned"\ntitle: ${JSON.stringify(title)}\nstage: "rough"\ncreatedAt: "2026-01-01T00:00:00.000Z"\nupdatedAt: "2026-01-01T00:00:00.000Z"\n---\n\nFile-backed body.\n`;
}

test('real observed files feed the actual store and read failures remain visible', async () => {
  const revisions = new GatewayResourceRevisions();
  const key = { family: 'planning', collection: 'roadmap' } as const;
  let source!: FSWatcher;
  const observation = await watchRoadmapItems(
    store.roadmapRoot,
    revisions,
    (directory, options, listener) => {
      source = watch(directory, options, listener);
      return source;
    },
  );
  store.setRoadmapObservationGuard(() => observation.assertReady());
  let revision = revisions.revision(key);
  async function changed(): Promise<void> {
    const deadline = Date.now() + 2000;
    while (revisions.revision(key) <= revision) {
      assert(Date.now() < deadline, 'The source writer must invalidate before the next read');
      await delay(10);
    }
    revision = revisions.revision(key);
  }
  try {
    const directory = path.join(store.roadmapRoot, 'inbox', 'items');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, 'external.md');
    await writeFile(file, item('Original'));
    await changed();
    assert.equal((await store.listRoadmapItems()).items[0].title, 'Original');
    await delay(60);
    await writeFile(file, 'broken markdown');
    await changed();
    await assert.rejects(store.listRoadmapItems(), /missing frontmatter/);
    await writeFile(`${file}.tmp`, item('Repaired'));
    await rename(`${file}.tmp`, file);
    await changed();
    assert.equal(
      (await store.getRoadmapItem({ itemId: 'ri_observed_file' })).item.title,
      'Repaired',
    );
    await rm(file);
    await changed();
    await assert.rejects(
      store.getRoadmapItem({ itemId: 'ri_observed_file' }),
      (error) => error instanceof GatewayMethodError && error.code === 'NOT_FOUND',
    );
    source.emit('error', new Error('lost source observation'));
    await assert.rejects(
      store.listRoadmapItems(),
      (error) =>
        error instanceof GatewayMethodError && error.code === 'RESOURCE_OBSERVATION_UNAVAILABLE',
    );
  } finally {
    await observation.close();
    store.setRoadmapObservationGuard(() => {});
    revisions.dispose();
  }
});
