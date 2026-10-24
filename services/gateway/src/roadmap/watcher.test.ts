import assert from 'node:assert/strict';
import { type FSWatcher, watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { GatewayMethodError } from '../core/method-error.js';
import { GatewayResourceRevisions } from '../resources/revisions.js';

import { watchRoadmapItems } from './watcher.js';

const key = { family: 'planning', collection: 'roadmap' } as const;

async function changed(revisions: GatewayResourceRevisions, previous: number): Promise<number> {
  const deadline = Date.now() + 2000;
  while (revisions.revision(key) <= previous) {
    assert(Date.now() < deadline, 'A real roadmap source write did not invalidate its collection');
    await delay(10);
  }
  return revisions.revision(key);
}

test('real item add, malformed edit, atomic replacement and unlink invalidate roadmap reads', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'roadmap-file-watch-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const revisions = new GatewayResourceRevisions();
  t.after(() => revisions.dispose());
  const root = path.join(home, 'configured-roadmap');
  const observation = await watchRoadmapItems(root, revisions);
  t.after(() => observation.close());
  observation.assertReady();
  assert.equal(revisions.revision(key), 0, 'Startup scanning is not a source mutation');
  for (const directory of [
    path.join(root, 'inbox', 'items'),
    path.join(root, 'projects', 'later-project', 'items', 'nested'),
  ]) {
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, 'item.md');
    let revision = revisions.revision(key);
    await writeFile(file, '# First source bytes\n');
    revision = await changed(revisions, revision);
    assert.equal(await readFile(file, 'utf8'), '# First source bytes\n');
    // Publication must not depend on successful parsing: this edit must make the real reader fail.
    await delay(60);
    await writeFile(file, 'malformed frontmatter');
    revision = await changed(revisions, revision);
    assert.equal(await readFile(file, 'utf8'), 'malformed frontmatter');
    const replacement = `${file}.tmp`;
    await writeFile(replacement, '# Atomic replacement\n');
    await rename(replacement, file);
    revision = await changed(revisions, revision);
    assert.equal(await readFile(file, 'utf8'), '# Atomic replacement\n');
    await rm(file);
    await changed(revisions, revision);
  }
  const revision = revisions.revision(key);
  await mkdir(path.join(root, 'promotion-drafts'), { recursive: true });
  await writeFile(path.join(root, 'promotion-drafts', 'not-an-item.md'), '# Draft\n');
  await writeFile(path.join(root, 'projects', 'later-project', 'project.json'), '{}');
  await delay(200);
  assert.equal(
    revisions.revision(key),
    revision,
    'Unrelated prompts, drafts and configs stay outside this observation',
  );
  await observation.close();
  await writeFile(path.join(root, 'inbox', 'items', 'after-close.md'), '# Closed\n');
  await delay(100);
  assert.equal(revisions.revision(key), revision, 'A retired observer cannot publish after close');
  assert.throws(
    () => observation.assertReady(),
    (error) =>
      error instanceof GatewayMethodError && error.code === 'RESOURCE_OBSERVATION_UNAVAILABLE',
  );
});

test('an observation error invalidates the collection and refuses freshness until restart', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'roadmap-watch-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const revisions = new GatewayResourceRevisions();
  t.after(() => revisions.dispose());
  let source!: FSWatcher;
  const observation = await watchRoadmapItems(root, revisions, (directory, options, listener) => {
    source = watch(directory, options, listener);
    return source;
  });
  t.after(() => observation.close());
  source.emit('error', new Error('watch descriptor lost'));
  assert.equal(revisions.revision(key), 1, 'Existing clients must retry into a visible failure');
  assert.throws(
    () => observation.assertReady(),
    (error) =>
      error instanceof GatewayMethodError &&
      error.code === 'RESOURCE_OBSERVATION_UNAVAILABLE' &&
      error.message.includes('watch descriptor lost'),
  );
  source.emit('change', 'change', 'inbox/items/item.md');
  assert.throws(
    () => observation.assertReady(),
    /filesystem observation is failed/,
    'A later event cannot silently restore a broken feed',
  );
});

test('startup refuses a real non-directory root and a queued native watch error', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'roadmap-watch-startup-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'not-a-directory');
  await writeFile(file, 'owned');
  await assert.rejects(watchRoadmapItems(file));
  await assert.rejects(
    watchRoadmapItems(path.join(home, 'failed-root'), undefined, (directory, options, listener) => {
      const source = watch(directory, options, listener);
      queueMicrotask(() => source.emit('error', new Error('startup watch denied')));
      return source;
    }),
    /startup watch denied/,
  );
});
