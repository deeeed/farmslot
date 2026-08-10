import assert from 'node:assert/strict';
import test from 'node:test';

import type { FileTransferProgress } from '@farmslot/protocol';

import {
  formatTransferBytes,
  pruneFileTransfers,
  transferPercent,
  upsertFileTransfer,
} from './file-transfer-progress-model.js';

function progress(
  partial: Partial<FileTransferProgress> & { transferId: string },
): FileTransferProgress {
  return {
    path: '/tmp/x.bin',
    phase: 'mirror',
    bytesTransferred: 0,
    totalBytes: 100,
    state: 'running',
    ...partial,
  };
}

test('upsertFileTransfer inserts and updates by transferId', () => {
  const a = progress({ transferId: 'a', bytesTransferred: 10 });
  const b = progress({ transferId: 'b', bytesTransferred: 20 });
  let entries = upsertFileTransfer([], a, 1);
  entries = upsertFileTransfer(entries, b, 2);
  entries = upsertFileTransfer(entries, progress({ transferId: 'a', bytesTransferred: 50 }), 3);
  assert.equal(entries.length, 2);
  assert.equal(entries.find((e) => e.transferId === 'a')?.bytesTransferred, 50);
});

test('pruneFileTransfers keeps running and recent terminal rows', () => {
  const entries = [
    { ...progress({ transferId: 'run', state: 'running' }), updatedAt: 0 },
    { ...progress({ transferId: 'old', state: 'done' }), updatedAt: 0 },
    { ...progress({ transferId: 'new', state: 'failed' }), updatedAt: 9_500 },
  ];
  const pruned = pruneFileTransfers(entries, 10_000, 8_000);
  assert.deepEqual(
    pruned.map((e) => e.transferId),
    ['run', 'new'],
  );
});

test('transferPercent and formatTransferBytes are determinate', () => {
  assert.equal(transferPercent({ bytesTransferred: 50, totalBytes: 100 }), 50);
  assert.equal(transferPercent({ bytesTransferred: 0, totalBytes: 0 }), 0);
  assert.match(formatTransferBytes(2048), /KiB/);
  assert.match(formatTransferBytes(3 * 1024 * 1024), /MiB/);
});
