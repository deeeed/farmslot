import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  FILE_TRANSFER_CHUNK_MAX_BYTES,
  FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES,
  type FileTransferCancelParams,
  type FileTransferCancelResult,
  type FileTransferListParams,
  type FileTransferListResult,
  type FileTransferSmokeParams,
  type FileTransferSmokeResult,
} from '@farmslot/protocol';

import {
  cancelTransfer,
  copyFileChunked,
  listActiveTransfers,
  readLocalFileChunk,
  writeTransferFixture,
} from '../core/file-transfer.js';

/**
 * Diagnostics smoke path: multi-chunk local fixture copy that emits the same
 * `file.transfer.progress` events as remote slotCopyFile. Gated for recipes and
 * operator UX proof without a remote node.
 *
 * Enable with FARMSLOT_ENABLE_TRANSFER_SMOKE=1 or when FARMSLOT_DISABLE_ORCHESTRATION=1
 * (validation / sandbox stacks).
 */
export function isFileTransferSmokeEnabled(): boolean {
  if (process.env.FARMSLOT_ENABLE_TRANSFER_SMOKE === '1') return true;
  if (process.env.FARMSLOT_ENABLE_TRANSFER_SMOKE === '0') return false;
  // Validation/sandbox stacks disable orchestration and are safe for smoke.
  return process.env.FARMSLOT_DISABLE_ORCHESTRATION === '1';
}

export async function fileTransferSmoke(
  params: FileTransferSmokeParams = {},
): Promise<FileTransferSmokeResult> {
  if (!isFileTransferSmokeEnabled()) {
    throw new Error(
      'diagnostics.fileTransfer.smoke is disabled; set FARMSLOT_ENABLE_TRANSFER_SMOKE=1',
    );
  }
  const totalBytes = Math.max(
    1,
    Math.floor(params.totalBytes ?? FILE_TRANSFER_CHUNK_MAX_BYTES * 3),
  );
  if (totalBytes <= FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES) {
    throw new Error(
      `diagnostics.fileTransfer.smoke totalBytes must exceed small-file threshold ` +
        `(${FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES}); got ${totalBytes}`,
    );
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-xfer-smoke-'));
  const src = path.join(dir, 'fixture.bin');
  const dest = path.join(dir, 'out.bin');
  const chunkDelayMs = Math.max(0, Math.floor(params.chunkDelayMs ?? 0));
  const phase = params.phase ?? 'mirror';

  try {
    await writeTransferFixture(src, totalBytes);
    let result = await copyFileChunked({
      path: src,
      label: params.label ?? 'after.mp4',
      phase,
      runId: params.runId,
      slotId: params.slotId,
      totalBytes,
      localPath: dest,
      keepPartialOnFailure: Boolean(params.exerciseResume),
      readChunk: async (offset, length) => {
        if (chunkDelayMs > 0) {
          await new Promise((r) => setTimeout(r, chunkDelayMs));
        }
        return readLocalFileChunk(src, offset, length);
      },
    });

    if (params.exerciseResume) {
      // Truncate mid-file and resume to prove keepPartial + resumeFromOffset.
      const mid = Math.floor(totalBytes / 2);
      await truncate(dest, mid);
      result = await copyFileChunked({
        path: src,
        label: params.label ?? 'after.mp4',
        phase,
        runId: params.runId,
        slotId: params.slotId,
        totalBytes,
        localPath: dest,
        resumeFromOffset: mid,
        readChunk: async (offset, length) => readLocalFileChunk(src, offset, length),
      });
    }

    const assembled = await readFile(dest);
    const sha256 = createHash('sha256').update(assembled).digest('hex');
    if (assembled.byteLength !== totalBytes || sha256 !== result.sha256) {
      throw new Error(
        `diagnostics.fileTransfer.smoke integrity failed: size ${assembled.byteLength}/${totalBytes}, sha ${sha256}/${result.sha256}`,
      );
    }

    const intermediateEvents = result.progressEvents.filter(
      (p) => p.state === 'running' && p.bytesTransferred > 0 && p.bytesTransferred < p.totalBytes,
    ).length;

    return {
      transferId: result.transferId,
      size: result.size,
      sha256: result.sha256,
      progressEvents: result.progressEvents.length,
      intermediateEvents,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function fileTransferCancel(
  params: FileTransferCancelParams,
): Promise<FileTransferCancelResult> {
  return cancelTransfer(params.transferId);
}

export async function fileTransferList(
  params: FileTransferListParams = {},
): Promise<FileTransferListResult> {
  return {
    transfers: listActiveTransfers({ runId: params.runId, slotId: params.slotId }),
  };
}

/** Export for tests that probe partial size after cancel-style failures. */
export async function fileSize(pathName: string): Promise<number> {
  return (await stat(pathName)).size;
}
