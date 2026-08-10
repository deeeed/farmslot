import assert from 'node:assert/strict';
import test from 'node:test';

import type { FileTransferProgress } from '@farmslot/protocol';

import {
  filterTransfersForRun,
  formatPipelineTransferMeta,
  type FileTransferUiEntry,
  upsertFileTransfer,
} from './file-transfer-progress-model.js';

// Pure helpers only — do not import the store module (it pulls the browser gateway).

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

test('formatPipelineTransferMeta shows percent and multi-file counts', () => {
  const entry: FileTransferUiEntry = {
    ...progress({
      transferId: 't1',
      label: 'artifacts',
      bytesTransferred: 40,
      totalBytes: 100,
      filesCompleted: 2,
      filesTotal: 5,
      state: 'running',
    }),
    updatedAt: 1,
  };
  assert.match(formatPipelineTransferMeta(entry), /40%/);
  assert.match(formatPipelineTransferMeta(entry), /2\/5f/);
});

test('filterTransfersForRun is strict — excludes unscoped transfers', () => {
  let entries = upsertFileTransfer([], progress({ transferId: 'a', runId: 'run-1' }), 1);
  entries = upsertFileTransfer(entries, progress({ transferId: 'b', runId: 'run-2' }), 2);
  entries = upsertFileTransfer(entries, progress({ transferId: 'c' }), 3);
  const forRun1 = filterTransfersForRun(entries, 'run-1');
  assert.equal(forRun1.length, 1);
  assert.equal(forRun1[0]?.transferId, 'a');
  assert.deepEqual(filterTransfersForRun(entries, null).map((e) => e.transferId).sort(), [
    'a',
    'b',
    'c',
  ]);
});

test('formatPipelineTransferMeta reports failed and cancelled', () => {
  assert.equal(
    formatPipelineTransferMeta({
      ...progress({ transferId: 'f', state: 'failed' }),
      updatedAt: 1,
    }),
    'failed',
  );
  assert.equal(
    formatPipelineTransferMeta({
      ...progress({ transferId: 'c', state: 'cancelled' }),
      updatedAt: 1,
    }),
    'cancelled',
  );
});
