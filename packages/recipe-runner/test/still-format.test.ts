import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { publishEvidenceStill } from '../src/evidence/still-format.js';

import { framePng } from './fixtures/png.js';

async function stillsRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'still-format-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'stills'));
  return root;
}

test('a webp still replaces the recorder PNG with lossy WebP', async (t) => {
  const root = await stillsRoot(t);
  await writeFile(path.join(root, 'stills/a.png'), framePng());

  assert.deepEqual(await publishEvidenceStill(root, 'stills/a.png', 'webp'), {
    path: 'stills/a.webp',
    mimeType: 'image/webp',
  });
  const webp = await readFile(path.join(root, 'stills/a.webp'));
  assert.equal(webp.subarray(0, 4).toString('latin1'), 'RIFF');
  assert.equal(webp.subarray(8, 16).toString('latin1'), 'WEBPVP8 ', 'lossy, not VP8L');
  assert.deepEqual(
    [webp.readUInt16LE(26) & 0x3fff, webp.readUInt16LE(28) & 0x3fff],
    [2, 2],
    'frame keeps its size',
  );
  assert.deepEqual(await readdir(path.join(root, 'stills')), ['a.webp']);
});

test('a png still is kept as the recorder wrote it', async (t) => {
  const root = await stillsRoot(t);
  await writeFile(path.join(root, 'stills/a.png'), framePng());

  assert.deepEqual(await publishEvidenceStill(root, 'stills/a.png', 'png'), {
    path: 'stills/a.png',
    mimeType: 'image/png',
  });
  assert.deepEqual(await readFile(path.join(root, 'stills/a.png')), framePng());
  assert.deepEqual(await readdir(path.join(root, 'stills')), ['a.png']);
});

test('a failed encode leaves no still and the encoder keeps serving', async (t) => {
  const root = await stillsRoot(t);
  await writeFile(path.join(root, 'stills/bad.png'), 'not a PNG');

  await assert.rejects(
    publishEvidenceStill(root, 'stills/bad.png', 'webp'),
    /WebP encoding failed/,
  );
  assert.deepEqual(await readdir(path.join(root, 'stills')), []);

  await writeFile(path.join(root, 'stills/good.png'), framePng());
  assert.equal(
    (await publishEvidenceStill(root, 'stills/good.png', 'webp')).path,
    'stills/good.webp',
  );
});
