import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ensureNodePackTemplateHash } from './node-pack-template.js';

const current = '5'.repeat(64);
const stale = '2'.repeat(64);

test('stale node catalog self-heals with exactly one packs-only sync', async () => {
  let reads = 0;
  let syncs = 0;
  let written = 0;
  await ensureNodePackTemplateHash({
    project: 'fixture',
    expectedHash: current,
    readHash: async () => (++reads === 1 ? stale : current),
    sync: async () => {
      syncs++;
    },
  });
  written++;
  assert.deepEqual({ reads, syncs, written }, { reads: 2, syncs: 1, written: 1 });
});

test('still-stale catalog refuses before write-task with both hashes', async () => {
  let reads = 0;
  let syncs = 0;
  let written = 0;
  await assert.rejects(
    async () => {
      await ensureNodePackTemplateHash({
        project: 'fixture',
        expectedHash: current,
        readHash: async () => {
          reads++;
          return stale;
        },
        sync: async () => {
          syncs++;
        },
      });
      written++;
    },
    { message: `node pack fixture at ${stale}, gateway at ${current}` },
  );
  assert.deepEqual({ reads, syncs, written }, { reads: 2, syncs: 1, written: 0 });
});

test('matching catalog does no sync and no second read', async () => {
  let reads = 0;
  await ensureNodePackTemplateHash({
    project: 'fixture',
    expectedHash: current,
    readHash: async () => {
      reads++;
      return current;
    },
    sync: async () => assert.fail('matching catalog must not sync'),
  });
  assert.equal(reads, 1);
});

test('repair rechecks the copied catalog bytes rather than a pack Git checkout', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-catalog-bytes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gateway = path.join(root, 'gateway-template.md');
  const node = path.join(root, 'copied-template.md');
  const gitCopy = path.join(root, 'unrelated-git-template.md');
  await writeFile(gateway, '# Current worker template\n');
  await writeFile(node, '# Old worker template\n');
  await writeFile(gitCopy, '# Intentionally retained checkout\n');
  const hash = async (file: string) =>
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  let syncs = 0;
  await ensureNodePackTemplateHash({
    project: 'fixture',
    expectedHash: await hash(gateway),
    readHash: () => hash(node),
    sync: async () => {
      syncs++;
      await cp(gateway, node);
    },
  });
  assert.equal(syncs, 1);
  assert.equal(await hash(node), await hash(gateway));
  assert.equal(await readFile(gitCopy, 'utf8'), '# Intentionally retained checkout\n');
});

test('a failed sync is rechecked and retained as the mismatch cause', async () => {
  let reads = 0;
  const failure = new Error('packs-only copy failed');
  await assert.rejects(
    ensureNodePackTemplateHash({
      project: 'fixture',
      expectedHash: current,
      readHash: async () => {
        reads++;
        return stale;
      },
      sync: async () => {
        throw failure;
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === `node pack fixture at ${stale}, gateway at ${current}` &&
      error.cause === failure,
  );
  assert.equal(reads, 2);
});
