import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  FILE_TRANSFER_CHUNK_MAX_BYTES,
  FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES,
  type FileTransferSmokeParams,
  type FileTransferSmokeResult,
} from '@farmslot/protocol';

import {
  copyFileChunked,
  readLocalFileChunk,
  writeTransferFixture,
} from '../core/file-transfer.js';

/**
 * Admin smoke path: multi-chunk local fixture copy that emits the same
 * `file.transfer.progress` events as remote slotCopyFile. Used by recipes and
 * operators to prove progress UX without a remote node.
 */
export async function fileTransferSmoke(
  params: FileTransferSmokeParams = {},
): Promise<FileTransferSmokeResult> {
  const totalBytes = Math.max(
    1,
    Math.floor(params.totalBytes ?? FILE_TRANSFER_CHUNK_MAX_BYTES * 3),
  );
  if (totalBytes <= FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES) {
    throw new Error(
      `file.transfer.smoke totalBytes must exceed small-file threshold ` +
        `(${FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES}); got ${totalBytes}`,
    );
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-xfer-smoke-'));
  const src = path.join(dir, 'fixture.bin');
  const dest = path.join(dir, 'out.bin');
  const chunkDelayMs = Math.max(0, Math.floor(params.chunkDelayMs ?? 0));

  try {
    await writeTransferFixture(src, totalBytes);
    const result = await copyFileChunked({
      path: src,
      label: params.label ?? 'fixture.bin',
      phase: 'download',
      runId: params.runId,
      slotId: params.slotId,
      totalBytes,
      localPath: dest,
      readChunk: async (offset, length) => {
        if (chunkDelayMs > 0) {
          await new Promise((r) => setTimeout(r, chunkDelayMs));
        }
        return readLocalFileChunk(src, offset, length);
      },
    });

    const assembled = await readFile(dest);
    const sha256 = createHash('sha256').update(assembled).digest('hex');
    if (assembled.byteLength !== totalBytes || sha256 !== result.sha256) {
      throw new Error(
        `file.transfer.smoke integrity failed: size ${assembled.byteLength}/${totalBytes}, sha ${sha256}/${result.sha256}`,
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
