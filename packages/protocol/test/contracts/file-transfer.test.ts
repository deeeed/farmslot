import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Events,
  FILE_TRANSFER_CHUNK_MAX_BYTES,
  FILE_TRANSFER_IDLE_TIMEOUT_MS,
  FILE_TRANSFER_PHASES,
  FILE_TRANSFER_PROGRESS_BROADCAST_MIN_INTERVAL_MS,
  FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES,
  FILE_TRANSFER_STATES,
  fileTransferIdleTimeoutMs,
  FileTransferMethods,
  type FileTransferProgress,
  Methods,
} from '../../src/index.js';

test('file transfer protocol exports chunk budget, phases, cancel, and progress event', () => {
  assert.equal(Methods.FILE_TRANSFER_SMOKE, 'file.transfer.smoke');
  assert.equal(Methods.DIAGNOSTICS_FILE_TRANSFER_SMOKE, 'diagnostics.fileTransfer.smoke');
  assert.equal(Methods.FILE_TRANSFER_CANCEL, 'file.transfer.cancel');
  assert.equal(Methods.FILE_TRANSFER_LIST, 'file.transfer.list');
  assert.equal(FileTransferMethods.smoke, 'diagnostics.fileTransfer.smoke');
  assert.equal(FileTransferMethods.cancel, 'file.transfer.cancel');
  assert.equal(Events.FILE_TRANSFER_PROGRESS, 'file.transfer.progress');
  assert.ok(FILE_TRANSFER_CHUNK_MAX_BYTES > 0);
  assert.ok(FILE_TRANSFER_CHUNK_MAX_BYTES < 100 * 1024 * 1024);
  assert.ok(FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES < FILE_TRANSFER_CHUNK_MAX_BYTES * 2);
  assert.ok(FILE_TRANSFER_IDLE_TIMEOUT_MS >= 30_000);
  assert.ok(FILE_TRANSFER_PROGRESS_BROADCAST_MIN_INTERVAL_MS <= 1000);
  assert.deepEqual(FILE_TRANSFER_PHASES, ['upload', 'download', 'mirror']);
  assert.deepEqual(FILE_TRANSFER_STATES, ['running', 'done', 'failed', 'cancelled']);
  assert.ok(fileTransferIdleTimeoutMs(200 * 1024 * 1024) > FILE_TRANSFER_IDLE_TIMEOUT_MS);

  const progress = {
    transferId: 'xfer-1',
    path: '/tmp/after.mp4',
    label: 'after.mp4',
    phase: 'mirror',
    bytesTransferred: 512 * 1024,
    totalBytes: 76 * 1024 * 1024,
    state: 'running',
    filesCompleted: 1,
    filesTotal: 3,
    cancellable: true,
  } satisfies FileTransferProgress;
  assert.equal(progress.state, 'running');
});
