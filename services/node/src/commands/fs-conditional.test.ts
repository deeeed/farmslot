import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { FsErrorCodes } from '@farmslot/protocol';

import { fsDelete, fsHash, fsRead, fsRename, fsWrite } from './fs.js';

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-node-conditional-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: (name: string) => path.join(root, name) };
}

async function refused(promise: Promise<unknown>, details: unknown) {
  await assert.rejects(promise, (error: NodeJS.ErrnoException & { details?: unknown }) => {
    assert.equal(error.code, FsErrorCodes.conflict, error.message);
    assert.deepEqual(error.details, details);
    return true;
  });
}

test('fsRead returns the raw-byte hash that fsHash reports', async (t) => {
  const { root, file } = await fixture(t);
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
  await writeFile(file('latin1.txt'), latin1);
  const read = await fsRead({ root, relPath: 'latin1.txt' });
  assert.equal(read.hash, (await fsHash({ root, relPath: 'latin1.txt' })).sha256);
  assert.equal(read.hash, sha256(latin1));
});

test('fsWrite checks expectedHash and returns the new hash', async (t) => {
  const { root, file } = await fixture(t);
  await writeFile(file('a.txt'), 'one');
  await refused(fsWrite({ root, relPath: 'a.txt', content: 'lost', expectedHash: 'stale' }), {
    reason: 'hash',
    currentHash: sha256('one'),
  });
  assert.equal(await readFile(file('a.txt'), 'utf8'), 'one');
  assert.deepEqual(
    await fsWrite({ root, relPath: 'a.txt', content: 'two', expectedHash: sha256('one') }),
    { ok: true, hash: sha256('two') },
  );
  await refused(fsWrite({ root, relPath: 'gone.txt', content: 'x', expectedHash: 'stale' }), {
    reason: 'hash',
  });
  await refused(fsWrite({ root, relPath: 'a.txt', content: 'lost', expectedHash: null }), {
    reason: 'hash',
    currentHash: sha256('two'),
  });
  assert.deepEqual(await fsWrite({ root, relPath: 'b.txt', content: 'b', expectedHash: null }), {
    ok: true,
    hash: sha256('b'),
  });
});

test('a guarded rename needs the source hash and an absent destination', async (t) => {
  const { root, file } = await fixture(t);
  await writeFile(file('a.txt'), 'a');
  await writeFile(file('b.txt'), 'b');
  const guarded = (newRelPath: string, expectedHash: string) =>
    fsRename({ root, oldRelPath: 'a.txt', newRelPath, expectedHash });
  await refused(guarded('b.txt', sha256('a')), {
    reason: 'destination-exists',
    currentHash: sha256('b'),
  });
  await refused(guarded('c.txt', 'stale'), { reason: 'hash', currentHash: sha256('a') });
  // A directory destination has no hash; a symlink destination keeps its refusal.
  await mkdir(file('dir'));
  await refused(guarded('dir', sha256('a')), { reason: 'destination-exists' });
  await symlink('b.txt', file('link'));
  await assert.rejects(guarded('link', sha256('a')), /Refusing final-component symlink: link/);
  assert.ok((await stat(file('dir'))).isDirectory());
  assert.equal(await readFile(file('a.txt'), 'utf8'), 'a');
  assert.equal(await readFile(file('b.txt'), 'utf8'), 'b');
  assert.deepEqual(await guarded('c.txt', sha256('a')), { ok: true, hash: sha256('a') });
  assert.equal(await readFile(file('c.txt'), 'utf8'), 'a');
});

test('a hashed delete removes only the file it names, and never a directory', async (t) => {
  const { root, file } = await fixture(t);
  await writeFile(file('a.txt'), 'a');
  await refused(fsDelete({ root, relPath: 'a.txt', expectedHash: 'stale' }), {
    reason: 'hash',
    currentHash: sha256('a'),
  });
  await fsDelete({ root, relPath: 'a.txt', expectedHash: sha256('a') });
  await assert.rejects(stat(file('a.txt')), { code: 'ENOENT' });
  await mkdir(file('dir'));
  await assert.rejects(
    fsDelete({ root, relPath: 'dir', expectedHash: sha256('') }),
    /File versions apply to files only/,
  );
  assert.ok((await stat(file('dir'))).isDirectory());
});
