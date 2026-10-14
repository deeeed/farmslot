import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotVars } from '../../core/config.js';

const writes: Array<{ baseDir: string; files: Array<{ path: string; content: string }> }> = [];
let commandCalls = 0;
let commandExitCode = 0;

mock.module('../../core/index.js', {
  namedExports: {
    execOnSlot: async () => {
      commandCalls++;
      return { exitCode: commandExitCode, stdout: '', stderr: 'No space left on device' };
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

const { writeLargeTextFileOnSlot, writeTextFileOnSlot } = await import('./slot-file-write.js');

test('large artifact writes use node file transfer instead of process argv', async () => {
  writes.length = 0;
  commandCalls = 0;
  const content = 'review-diff\n'.repeat(50_000);
  const vars = {
    host: 'remote.example',
    machine: 'remote',
    remoteRepo: '/workspace/repo',
  } as SlotVars;

  await writeLargeTextFileOnSlot(vars, 'temp/task/artifacts/review.diff', content);

  assert.equal(writes.length, 1);
  assert.equal(commandCalls, 0);
  assert.equal(writes[0]?.baseDir, '/workspace/repo/temp/task/artifacts');
  assert.equal(writes[0]?.files[0]?.path, 'review.diff');
  assert.equal(Buffer.from(writes[0]?.files[0]?.content ?? '', 'base64').toString(), content);
});

test('remote text writes reject a nonzero transport exit and accept successful writes', async () => {
  const vars = {
    host: 'remote.example',
    machine: 'remote',
    remoteRepo: '/workspace/repo',
  } as SlotVars;
  commandExitCode = 1;
  await assert.rejects(
    writeTextFileOnSlot(vars, 'inputs/contract.json', '{}'),
    /remote command exited 1.*No space left/,
  );
  commandExitCode = 0;
  await writeTextFileOnSlot(vars, 'inputs/contract.json', '{}');
});
