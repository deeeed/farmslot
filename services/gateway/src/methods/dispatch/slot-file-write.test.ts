import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotVars } from '../../core/config.js';

const writes: Array<{ baseDir: string; files: Array<{ path: string; content: string }> }> = [];

mock.module('../../core/index.js', {
  namedExports: {
    execOnSlot: async () => {
      throw new Error('large artifact writes must not use command argv');
    },
    isLocal: () => false,
    slotWriteFiles: async (
      _vars: SlotVars,
      baseDir: string,
      files: Array<{ path: string; content: string }>,
    ) => {
      writes.push({ baseDir, files });
    },
  },
});

const { writeLargeTextFileOnSlot } = await import('./slot-file-write.js');

test('large artifact writes use node file transfer instead of process argv', async () => {
  writes.length = 0;
  const content = 'review-diff\n'.repeat(50_000);
  const vars = {
    host: 'remote.example',
    machine: 'remote',
    remoteRepo: '/workspace/repo',
  } as SlotVars;

  await writeLargeTextFileOnSlot(vars, 'temp/task/artifacts/review.diff', content);

  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.baseDir, '/workspace/repo/temp/task/artifacts');
  assert.equal(writes[0]?.files[0]?.path, 'review.diff');
  assert.equal(Buffer.from(writes[0]?.files[0]?.content ?? '', 'base64').toString(), content);
});
