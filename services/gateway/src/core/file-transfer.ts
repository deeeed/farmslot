// Progress-aware chunked file transfer (node → gateway local dest).
// Emits FileTransferProgress so Command Center can show determinate status and so
// timeouts are idle-based instead of a single fixed sendNodeRequest wall clock.

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { finished } from 'node:stream/promises';

import {
  Events,
  FILE_TRANSFER_CHUNK_MAX_BYTES,
  FILE_TRANSFER_IDLE_TIMEOUT_MS,
  type FileTransferPhase,
  type FileTransferProgress,
  type FileTransferState,
} from '@farmslot/protocol';

export type FileTransferBroadcast = (event: string, payload: unknown) => void;

let broadcastFn: FileTransferBroadcast = () => {};

export function setFileTransferBroadcast(broadcast: FileTransferBroadcast): void {
  broadcastFn = broadcast;
}

export function emitFileTransferProgress(progress: FileTransferProgress): void {
  broadcastFn(Events.FILE_TRANSFER_PROGRESS, progress);
}

export interface TransferClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: TransferClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface ChunkReadResult {
  content: string;
  size: number;
  offset: number;
  bytesRead: number;
  eof: boolean;
}

export interface ChunkedCopyParams {
  transferId?: string;
  path: string;
  label?: string;
  phase: FileTransferPhase;
  runId?: string;
  slotId?: string;
  /** Total size when known up-front (e.g. from fs.stat). Updated from first chunk if omitted. */
  totalBytes?: number;
  chunkMaxBytes?: number;
  idleTimeoutMs?: number;
  clock?: TransferClock;
  /**
   * When true (default), write assembled bytes to `localPath`. Smoke tests may
   * set false and only exercise progress + integrity of assembled buffer.
   */
  localPath?: string;
  readChunk: (offset: number, length: number) => Promise<ChunkReadResult>;
  onProgress?: (progress: FileTransferProgress) => void;
}

export interface ChunkedCopyResult {
  transferId: string;
  size: number;
  sha256: string;
  progressEvents: FileTransferProgress[];
}

export class FileTransferIdleTimeoutError extends Error {
  readonly bytesTransferred: number;
  readonly totalBytes: number;
  readonly transferId: string;

  constructor(args: {
    transferId: string;
    bytesTransferred: number;
    totalBytes: number;
    idleTimeoutMs: number;
  }) {
    super(
      `File transfer idle timeout after ${args.idleTimeoutMs}ms ` +
        `(last progress ${args.bytesTransferred}/${args.totalBytes} bytes, id=${args.transferId})`,
    );
    this.name = 'FileTransferIdleTimeoutError';
    this.bytesTransferred = args.bytesTransferred;
    this.totalBytes = args.totalBytes;
    this.transferId = args.transferId;
  }
}

export class FileTransferIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileTransferIntegrityError';
  }
}

function buildProgress(
  base: Omit<FileTransferProgress, 'state' | 'bytesTransferred' | 'totalBytes' | 'error' | 'sha256'>,
  state: FileTransferState,
  bytesTransferred: number,
  totalBytes: number,
  extra?: { error?: string; sha256?: string },
): FileTransferProgress {
  const progress: FileTransferProgress = {
    ...base,
    bytesTransferred,
    totalBytes,
    state,
  };
  if (extra?.error) progress.error = extra.error;
  if (extra?.sha256) progress.sha256 = extra.sha256;
  return progress;
}

/**
 * Copy a remote file via sequential base64 chunks, emitting progress after each
 * chunk (and at start/done/failed). Idle timeout fails closed with the last
 * known byte counters.
 */
export async function copyFileChunked(params: ChunkedCopyParams): Promise<ChunkedCopyResult> {
  const transferId = params.transferId ?? randomUUID();
  const chunkMax = params.chunkMaxBytes ?? FILE_TRANSFER_CHUNK_MAX_BYTES;
  const idleTimeoutMs = params.idleTimeoutMs ?? FILE_TRANSFER_IDLE_TIMEOUT_MS;
  const clock = params.clock ?? realClock;
  const label = params.label ?? basename(params.path);
  const base = {
    transferId,
    path: params.path,
    label,
    phase: params.phase,
    runId: params.runId,
    slotId: params.slotId,
  };

  const progressEvents: FileTransferProgress[] = [];
  const emit = (progress: FileTransferProgress) => {
    progressEvents.push(progress);
    params.onProgress?.(progress);
    emitFileTransferProgress(progress);
  };

  let bytesTransferred = 0;
  let totalBytes = params.totalBytes ?? 0;
  let lastProgressAt = clock.now();
  const hash = createHash('sha256');
  let writeStream: ReturnType<typeof createWriteStream> | null = null;
  let failed = false;

  const publish = (
    state: FileTransferState,
    extra?: { error?: string; sha256?: string },
  ): FileTransferProgress => {
    const progress = buildProgress(base, state, bytesTransferred, totalBytes, extra);
    emit(progress);
    lastProgressAt = clock.now();
    return progress;
  };

  try {
    publish('running');

    if (params.localPath) {
      writeStream = createWriteStream(params.localPath);
    }

    let offset = 0;
    let eof = false;
    while (!eof) {
      // Idle watchdog: if the previous chunk finished too long ago relative to
      // "now" before starting the next read, fail closed. Callers that inject a
      // slow readChunk are covered by the post-read check below as well.
      if (clock.now() - lastProgressAt > idleTimeoutMs) {
        throw new FileTransferIdleTimeoutError({
          transferId,
          bytesTransferred,
          totalBytes,
          idleTimeoutMs,
        });
      }

      const chunk = await params.readChunk(offset, chunkMax);

      if (clock.now() - lastProgressAt > idleTimeoutMs) {
        throw new FileTransferIdleTimeoutError({
          transferId,
          bytesTransferred,
          totalBytes,
          idleTimeoutMs,
        });
      }

      if (chunk.offset !== offset) {
        throw new FileTransferIntegrityError(
          `Chunk offset mismatch: expected ${offset}, got ${chunk.offset} for ${params.path}`,
        );
      }
      if (chunk.bytesRead < 0 || chunk.bytesRead > chunkMax) {
        throw new FileTransferIntegrityError(
          `Invalid bytesRead ${chunk.bytesRead} (chunk max ${chunkMax}) for ${params.path}`,
        );
      }

      if (totalBytes === 0 && chunk.size > 0) totalBytes = chunk.size;
      if (totalBytes > 0 && chunk.size > 0 && chunk.size !== totalBytes) {
        throw new FileTransferIntegrityError(
          `Remote size changed during transfer for ${params.path}: was ${totalBytes}, now ${chunk.size}`,
        );
      }

      const buf = Buffer.from(chunk.content, 'base64');
      if (buf.byteLength !== chunk.bytesRead) {
        throw new FileTransferIntegrityError(
          `Base64 length mismatch for ${params.path}: decoded ${buf.byteLength}, claimed ${chunk.bytesRead}`,
        );
      }

      // Empty final chunk is allowed only at eof with zero remaining bytes.
      if (chunk.bytesRead === 0) {
        if (!chunk.eof && (totalBytes === 0 || offset < totalBytes)) {
          throw new FileTransferIntegrityError(
            `Empty non-eof chunk at offset ${offset} for ${params.path}`,
          );
        }
        eof = true;
        break;
      }

      hash.update(buf);
      if (writeStream) {
        if (!writeStream.write(buf)) {
          await new Promise<void>((resolve, reject) => {
            writeStream!.once('drain', resolve);
            writeStream!.once('error', reject);
          });
        }
      }

      bytesTransferred += chunk.bytesRead;
      offset += chunk.bytesRead;
      eof = chunk.eof || (totalBytes > 0 && offset >= totalBytes);
      publish('running');
    }

    if (totalBytes > 0 && bytesTransferred !== totalBytes) {
      throw new FileTransferIntegrityError(
        `Assembled size ${bytesTransferred} !== totalBytes ${totalBytes} for ${params.path}`,
      );
    }
    if (totalBytes === 0) totalBytes = bytesTransferred;

    if (writeStream) {
      writeStream.end();
      await finished(writeStream);
      writeStream = null;
    }

    const sha256 = hash.digest('hex');
    publish('done', { sha256 });
    return { transferId, size: bytesTransferred, sha256, progressEvents };
  } catch (err) {
    failed = true;
    const message = err instanceof Error ? err.message : String(err);
    publish('failed', { error: message });
    if (writeStream) {
      writeStream.destroy();
      writeStream = null;
    }
    if (params.localPath) {
      try {
        await rm(params.localPath, { force: true });
      } catch (cleanupErr) {
        // Partial file cleanup is best-effort; the transfer error is authoritative.
        console.warn(
          `[file-transfer] failed to remove partial ${params.localPath}: ${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`,
        );
      }
    }
    throw err;
  } finally {
    if (!failed && writeStream) {
      writeStream.destroy();
    }
  }
}

/** Local-file chunk reader used by smoke RPC and unit tests. */
export async function readLocalFileChunk(
  filePath: string,
  offset: number,
  length: number,
): Promise<ChunkReadResult> {
  const handle = await open(filePath, 'r');
  try {
    const info = await handle.stat();
    if (offset > info.size) {
      throw new Error(`offset ${offset} beyond size ${info.size}`);
    }
    const toRead = Math.min(length, info.size - offset);
    const buf = Buffer.alloc(toRead);
    const { bytesRead } = await handle.read(buf, 0, toRead, offset);
    const slice = bytesRead === toRead ? buf : buf.subarray(0, bytesRead);
    return {
      content: slice.toString('base64'),
      size: info.size,
      offset,
      bytesRead,
      eof: offset + bytesRead >= info.size,
    };
  } finally {
    await handle.close();
  }
}

/** Write a deterministic fixture of `size` bytes for smoke / tests. */
export async function writeTransferFixture(filePath: string, size: number): Promise<void> {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = i % 251;
  await writeFile(filePath, buf);
}
