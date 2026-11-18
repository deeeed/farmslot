import assert from 'node:assert/strict';
import test from 'node:test';

import { searchArtifactText } from './artifact-search.js';

test('literal content matches are grouped by file with original one-based lines', async () => {
  const result = await searchArtifactText(
    ['artifacts/report.md', 'artifacts/log.json'],
    'watch [ready]',
    async (path) => ({
      bytes: 100,
      sha256: 'a'.repeat(64),
      read: async () =>
        path.endsWith('.md') ? 'heading\r\nWatch [ready] now\nlast' : '{"message":"WATCH [READY]"}',
    }),
  );
  assert.deepEqual(
    result.files.map((f) => [f.path, f.hits.map((h) => h.line)]),
    [
      ['artifacts/report.md', [2]],
      ['artifacts/log.json', [1]],
    ],
  );
  assert.match(result.files[0].hits[0].text, /Watch \[ready\]/);
  assert.equal(result.partial, false);
});

test('search bounds reads and results, skips binary and large files, and names incomplete coverage', async () => {
  const opened: string[] = [];
  const result = await searchArtifactText(
    ['a.log', 'b.md', 'c.json', 'image.png'],
    'hit',
    async (path) => ({
      bytes: path === 'b.md' ? 2_000_000 : 40,
      sha256: 'a'.repeat(64),
      read: async () => {
        opened.push(path);
        return path === 'c.json' ? '\0hit' : 'hit\n'.repeat(200);
      },
    }),
  );
  assert.equal(result.files[0].hits.length, 100);
  assert(result.partial);
  assert(!opened.includes('b.md'));
  assert(!opened.includes('image.png'));
});

test('no-match and unreadable files are distinct, without treating a read failure as an empty result', async () => {
  const result = await searchArtifactText(['a.log', 'b.json'], 'needle', async (path) => {
    if (path === 'b.json') throw Error('Not retained');
    return { bytes: 20, sha256: 'a'.repeat(64), read: async () => 'other text' };
  });
  assert.deepEqual(result.files, []);
  assert.equal(result.skippedFiles, 1);
  assert.equal(result.partial, true);
});

test('blank and overlong queries are rejected before reading', async () => {
  const read = async () => {
    throw Error('must not read');
  };
  await assert.rejects(searchArtifactText(['a.log'], '', read), /query/);
  await assert.rejects(searchArtifactText(['a.log'], 'x'.repeat(201), read), /query/);
});

test('large and binary documents never become matches, even without hitting result limits', async () => {
  const read: string[] = [];
  const result = await searchArtifactText(
    ['small.log', 'large.md', 'binary.json', 'photo.png'],
    'needle',
    async (path) => ({
      bytes: path === 'large.md' ? 2_000_000 : 10,
      sha256: 'a'.repeat(64),
      read: async () => {
        read.push(path);
        return path === 'binary.json' ? '\0needle' : 'needle';
      },
    }),
  );
  assert.deepEqual(read, ['small.log', 'binary.json']);
  assert.deepEqual(
    result.files.map((f) => f.path),
    ['small.log'],
  );
  assert.equal(result.skippedFiles, 2);
  assert(result.partial);
});
