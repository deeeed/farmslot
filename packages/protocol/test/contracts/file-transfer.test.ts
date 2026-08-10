import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Events,
  FILE_TRANSFER_CHUNK_MAX_BYTES,
  FILE_TRANSFER_IDLE_TIMEOUT_MS,
  FILE_TRANSFER_PHASES,
  FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES,
  FILE_TRANSFER_STATES,
  type FileTransferProgress,
  FileTransferMethods,
  Methods,
} from '../../src/index.js';

test('file transfer protocol exports chunk budget, phases, and progress event', () => {
  assert.equal(Methods.FILE_TRANSFER_SMOKE, 'file.transfer.smoke');
  assert.equal(FileTransferMethods.smoke, 'file.transfer.smoke');
  assert.equal(Events.FILE_TRANSFER_PROGRESS, 'file.transfer.progress');
  assert.ok(FILE_TRANSFER_CHUNK_MAX_BYTES > 0);
  assert.ok(FILE_TRANSFER_CHUNK_MAX_BYTES < 100 * 1024 * 1024);
  assert.ok(FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES < FILE_TRANSFER_CHUNK_MAX_BYTES * 2);
  assert.ok(FILE_TRANSFER_IDLE_TIMEOUT_MS >= 30_000);
  assert.deepEqual(FILE_TRANSFER_PHASES, ['upload', 'download', 'mirror']);
  assert.deepEqual(FILE_TRANSFER_STATES, ['running', 'done', 'failed']);

  const progress = {
    transferId: 'xfer-1',
    path: '/tmp/after.mp4',
    label: 'after.mp4',
    phase: 'mirror',
    bytesTransferred: 512 * 1024,
    totalBytes: 76 * 1024 * 1024,
    state: 'running',
  } satisfies FileTransferProgress;
  assert.equal(progress.state, 'running');
});
