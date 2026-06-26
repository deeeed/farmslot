import assert from 'node:assert/strict';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readPrepareLogTailChunk } from './prepare.js';

test('readPrepareLogTailChunk rereads from zero when a log is truncated', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-prepare-log-'));
  try {
    const logPath = path.join(dir, 'prepare.log');
    await writeFile(logPath, 'old build output\n', 'utf-8');
    const first = await readPrepareLogTailChunk(logPath, 0);

    await truncate(logPath, 0);
    await writeFile(logPath, 'fresh\n', 'utf-8');
    const second = await readPrepareLogTailChunk(logPath, first.offset);

    assert.equal(first.output, 'old build output\n');
    assert.equal(second.output, 'fresh\n');
    assert.equal(second.offset, Buffer.byteLength('fresh\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
