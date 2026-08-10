// Progress-aware chunked file transfer (node ↔ gateway).
// Emits FileTransferProgress so Command Center can show determinate status and so
// timeouts are idle-based (size-scaled) instead of a fixed sendNodeRequest wall clock.

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { finished } from 'node:stream/promises';

import {
  Events,
  FILE_TRANSFER_CHUNK_MAX_BYTES,
  FILE_TRANSFER_PROGRESS_BROADCAST_MIN_INTERVAL_MS,
  fileTransferIdleTimeoutMs,
  type FileTransferEncoding,
  type FileTransferPhase,
  type FileTransferProgress,
  type FileTransferState,
} from '@farmslot/protocol';

export type FileTransferBroadcast = (event: string, payload: unknown) => void;

let broadcastFn: FileTransferBroadcast = () => {};

export function setFileTransferBroadcast(broadcast: FileTransferBroadcast): void {
  broadcastFn = broadcast;
}

// ─── Active session registry (cancel / list / UI) ───

interface ActiveTransfer {
  abort: AbortController;
  progress: FileTransferProgress;
  lastBroadcastAt: number;
}

const activeTransfers = new Map<string, ActiveTransfer>();

export function listActiveTransfers(filter?: {
  runId?: string;
  slotId?: string;
}): FileTransferProgress[] {
  const all = [...activeTransfers.values()].map((t) => t.progress);
  return all.filter((p) => {
    if (filter?.runId && p.runId !== filter.runId) return false;
    if (filter?.slotId && p.slotId !== filter.slotId) return false;
    return true;
  });
}

export function cancelTransfer(transferId: string): {
  ok: true;
  transferId: string;
  state: 'cancelled' | 'already-terminal';
} {
  const entry = activeTransfers.get(transferId);
  if (!entry) {
    return { ok: true, transferId, state: 'already-terminal' };
  }
  if (entry.progress.state !== 'running') {
    return { ok: true, transferId, state: 'already-terminal' };
  }
  entry.abort.abort(new FileTransferCancelledError(transferId));
  return { ok: true, transferId, state: 'cancelled' };
}

function registerActive(transferId: string, progress: FileTransferProgress): AbortController {
  const existing = activeTransfers.get(transferId);
  if (existing) return existing.abort;
  const abort = new AbortController();
  activeTransfers.set(transferId, { abort, progress, lastBroadcastAt: 0 });
  return abort;
}

function updateActive(progress: FileTransferProgress): void {
  const entry = activeTransfers.get(progress.transferId);
  if (entry) entry.progress = progress;
}

function unregisterActive(transferId: string): void {
  activeTransfers.delete(transferId);
}

export function emitFileTransferProgress(
  progress: FileTransferProgress,
  opts?: { force?: boolean; now?: number },
): void {
  const now = opts?.now ?? Date.now();
  const entry = activeTransfers.get(progress.transferId);
  const bytesAdvanced =
    entry != null && progress.bytesTransferred !== entry.progress.bytesTransferred;
  const filled =
    progress.state === 'running' &&
    progress.totalBytes > 0 &&
    progress.bytesTransferred >= progress.totalBytes;
  const intervalOk =
    !entry || now - entry.lastBroadcastAt >= FILE_TRANSFER_PROGRESS_BROADCAST_MIN_INTERVAL_MS;
  const force =
    opts?.force ||
    progress.state !== 'running' ||
    !entry ||
    filled ||
    (bytesAdvanced && intervalOk) ||
    // Always surface the first non-zero progress so single-chunk transfers paint.
    (bytesAdvanced && entry.progress.bytesTransferred === 0);
  if (entry) {
    entry.progress = progress;
    if (force) entry.lastBroadcastAt = now;
  }
  if (!force) return;
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
  encoding?: FileTransferEncoding;
}

export interface ChunkedCopyParams {
  transferId?: string;
  path: string;
  label?: string;
  phase: FileTransferPhase;
  runId?: string;
  slotId?: string;
  parentTransferId?: string;
  filesCompleted?: number;
  filesTotal?: number;
  /** Total size when known up-front (e.g. from fs.stat). Updated from first chunk if omitted. */
  totalBytes?: number;
  chunkMaxBytes?: number;
  idleTimeoutMs?: number;
  clock?: TransferClock;
  localPath?: string;
  /**
   * Resume from this byte offset (requires local partial of that size when localPath set).
   * Hash is recomputed by re-reading the partial prefix.
   */
  resumeFromOffset?: number;
  /** Keep partial local file on failure for a later resume (default false = remove). */
  keepPartialOnFailure?: boolean;
  /** Preferred encoding for chunk payloads (default base64). */
  encoding?: FileTransferEncoding;
  /** Optional remote integrity hash; transfer fails if assembled digest differs. */
  expectedSha256?: string;
  /** Optional remote hash provider run after assembly (e.g. node fs.hash). */
  fetchRemoteSha256?: () => Promise<string | undefined>;
  abortSignal?: AbortSignal;
  readChunk: (offset: number, length: number) => Promise<ChunkReadResult>;
  onProgress?: (progress: FileTransferProgress) => void;
}

export interface ChunkedCopyResult {
  transferId: string;
  size: number;
  sha256: string;
  progressEvents: FileTransferProgress[];
  resumedFrom?: number;
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

export class FileTransferCancelledError extends Error {
  readonly transferId: string;
  constructor(transferId: string) {
    super(`File transfer cancelled (id=${transferId})`);
    this.name = 'FileTransferCancelledError';
    this.transferId = transferId;
  }
}

function mergeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const controller = new AbortController();
  const forward = (signal: AbortSignal) => {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  };
  forward(a);
  forward(b);
  return controller.signal;
}

function decodeChunkContent(
  content: string,
  encoding: FileTransferEncoding | undefined,
  bytesRead: number,
  pathLabel: string,
): Buffer {
  const enc = encoding ?? 'base64';
  if (enc === 'binary') {
    // Raw binary was base64-encoded for JSON transport when the node cannot send binary frames.
    const buf = Buffer.from(content, 'base64');
    if (buf.byteLength !== bytesRead) {
      throw new FileTransferIntegrityError(
        `Binary/base64 length mismatch for ${pathLabel}: decoded ${buf.byteLength}, claimed ${bytesRead}`,
      );
    }
    return buf;
  }
  const buf = Buffer.from(content, 'base64');
  if (buf.byteLength !== bytesRead) {
    throw new FileTransferIntegrityError(
      `Base64 length mismatch for ${pathLabel}: decoded ${buf.byteLength}, claimed ${bytesRead}`,
    );
  }
  return buf;
}

function buildProgress(
  base: Omit<
    FileTransferProgress,
    'state' | 'bytesTransferred' | 'totalBytes' | 'error' | 'sha256' | 'bytesPerSec'
  >,
  state: FileTransferState,
  bytesTransferred: number,
  totalBytes: number,
  extra?: { error?: string; sha256?: string; bytesPerSec?: number; resumeOffset?: number },
): FileTransferProgress {
  const progress: FileTransferProgress = {
    ...base,
    bytesTransferred,
    totalBytes,
    state,
    cancellable: state === 'running',
  };
  if (extra?.error) progress.error = extra.error;
  if (extra?.sha256) progress.sha256 = extra.sha256;
  if (extra?.bytesPerSec != null) progress.bytesPerSec = extra.bytesPerSec;
  if (extra?.resumeOffset != null) progress.resumeOffset = extra.resumeOffset;
  return progress;
}

/**
 * Copy a remote file via sequential chunks, emitting progress (throttled for
 * running, always for terminal). Idle timeout is size-scaled by default.
 */
export async function copyFileChunked(params: ChunkedCopyParams): Promise<ChunkedCopyResult> {
  const transferId = params.transferId ?? randomUUID();
  const chunkMax = params.chunkMaxBytes ?? FILE_TRANSFER_CHUNK_MAX_BYTES;
  const clock = params.clock ?? realClock;
  const label = params.label ?? basename(params.path);
  const encoding = params.encoding ?? 'base64';
  let totalBytes = params.totalBytes ?? 0;
  const idleTimeoutMs =
    params.idleTimeoutMs ?? fileTransferIdleTimeoutMs(totalBytes > 0 ? totalBytes : chunkMax * 4);

  const base = {
    transferId,
    path: params.path,
    label,
    phase: params.phase,
    runId: params.runId,
    slotId: params.slotId,
    parentTransferId: params.parentTransferId,
    filesCompleted: params.filesCompleted,
    filesTotal: params.filesTotal,
    encoding,
  };

  const progressEvents: FileTransferProgress[] = [];
  const sessionAbort = registerActive(
    transferId,
    buildProgress(base, 'running', params.resumeFromOffset ?? 0, totalBytes, {
      resumeOffset: params.resumeFromOffset,
    }),
  );

  const combinedSignal = params.abortSignal
    ? mergeAbortSignals(params.abortSignal, sessionAbort.signal)
    : sessionAbort.signal;

  const emit = (progress: FileTransferProgress, force = false) => {
    progressEvents.push(progress);
    params.onProgress?.(progress);
    updateActive(progress);
    emitFileTransferProgress(progress, { force, now: clock.now() });
  };

  let bytesTransferred = 0;
  let lastProgressAt = clock.now();
  const startedAt = clock.now();
  const hash = createHash('sha256');
  let writeStream: ReturnType<typeof createWriteStream> | null = null;
  let failed = false;
  let cancelled = false;
  const resumeFrom = Math.max(0, Math.floor(params.resumeFromOffset ?? 0));

  const publish = (
    state: FileTransferState,
    extra?: { error?: string; sha256?: string },
    force = state !== 'running',
  ): FileTransferProgress => {
    const elapsedSec = Math.max(0.001, (clock.now() - startedAt) / 1000);
    const progress = buildProgress(base, state, bytesTransferred, totalBytes, {
      ...extra,
      bytesPerSec: Math.round(bytesTransferred / elapsedSec),
      resumeOffset: resumeFrom > 0 ? resumeFrom : undefined,
    });
    emit(progress, force);
    if (state === 'running') lastProgressAt = clock.now();
    return progress;
  };

  const throwIfAborted = () => {
    if (combinedSignal.aborted) {
      cancelled = true;
      throw new FileTransferCancelledError(transferId);
    }
  };

  try {
    if (params.localPath && resumeFrom > 0) {
      if (!existsSync(params.localPath)) {
        throw new FileTransferIntegrityError(
          `Resume offset ${resumeFrom} but partial missing: ${params.localPath}`,
        );
      }
      const st = await stat(params.localPath);
      if (st.size < resumeFrom) {
        throw new FileTransferIntegrityError(
          `Partial size ${st.size} < resume offset ${resumeFrom} for ${params.localPath}`,
        );
      }
      // Re-hash prefix so integrity covers the full assembled file.
      const handle = await open(params.localPath, 'r');
      try {
        const buf = Buffer.alloc(64 * 1024);
        let off = 0;
        while (off < resumeFrom) {
          const toRead = Math.min(buf.byteLength, resumeFrom - off);
          const { bytesRead } = await handle.read(buf, 0, toRead, off);
          if (bytesRead === 0) break;
          hash.update(buf.subarray(0, bytesRead));
          off += bytesRead;
        }
      } finally {
        await handle.close();
      }
      if (st.size > resumeFrom) {
        // Truncate any overshoot from a previous crash after the resume point.
        const { truncate } = await import('node:fs/promises');
        await truncate(params.localPath, resumeFrom);
      }
      bytesTransferred = resumeFrom;
      writeStream = createWriteStream(params.localPath, { flags: 'a' });
    } else if (params.localPath) {
      writeStream = createWriteStream(params.localPath);
    }

    publish('running', undefined, true);

    let offset = resumeFrom;
    let eof = totalBytes > 0 && offset >= totalBytes;
    while (!eof) {
      throwIfAborted();
      if (clock.now() - lastProgressAt > idleTimeoutMs) {
        throw new FileTransferIdleTimeoutError({
          transferId,
          bytesTransferred,
          totalBytes,
          idleTimeoutMs,
        });
      }

      const chunk = await params.readChunk(offset, chunkMax);
      throwIfAborted();

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

      if (chunk.bytesRead === 0) {
        if (!chunk.eof && (totalBytes === 0 || offset < totalBytes)) {
          throw new FileTransferIntegrityError(
            `Empty non-eof chunk at offset ${offset} for ${params.path}`,
          );
        }
        eof = true;
        break;
      }

      const buf = decodeChunkContent(
        chunk.content,
        chunk.encoding ?? encoding,
        chunk.bytesRead,
        params.path,
      );

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

    throwIfAborted();

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
    if (params.expectedSha256 && params.expectedSha256 !== sha256) {
      throw new FileTransferIntegrityError(
        `Assembled sha256 ${sha256} !== expected ${params.expectedSha256} for ${params.path}`,
      );
    }
    if (params.fetchRemoteSha256) {
      const remote = await params.fetchRemoteSha256();
      if (remote && remote !== sha256) {
        throw new FileTransferIntegrityError(
          `Assembled sha256 ${sha256} !== remote ${remote} for ${params.path}`,
        );
      }
    }

    publish('done', { sha256 }, true);
    return {
      transferId,
      size: bytesTransferred,
      sha256,
      progressEvents,
      resumedFrom: resumeFrom > 0 ? resumeFrom : undefined,
    };
  } catch (err) {
    failed = true;
    const isCancel =
      err instanceof FileTransferCancelledError ||
      (err instanceof Error && err.name === 'AbortError') ||
      cancelled;
    const message = err instanceof Error ? err.message : String(err);
    publish(isCancel ? 'cancelled' : 'failed', { error: message }, true);
    if (writeStream) {
      writeStream.destroy();
      writeStream = null;
    }
    if (params.localPath && !params.keepPartialOnFailure && !isCancel) {
      try {
        await rm(params.localPath, { force: true });
      } catch (cleanupErr) {
        console.warn(
          `[file-transfer] failed to remove partial ${params.localPath}: ${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`,
        );
      }
    }
    // On cancel, keep partial by default so resume is possible.
    throw isCancel && !(err instanceof FileTransferCancelledError)
      ? new FileTransferCancelledError(transferId)
      : err;
  } finally {
    unregisterActive(transferId);
    if (!failed && writeStream) {
      writeStream.destroy();
    }
  }
}

/** Multi-file aggregate session for slotCopyDir / mirrors. */
export class AggregateTransferSession {
  readonly transferId: string;
  private filesCompleted = 0;
  private bytesTransferred = 0;
  private readonly totalBytes: number;
  private readonly filesTotal: number;
  private readonly base: Omit<
    FileTransferProgress,
    'state' | 'bytesTransferred' | 'totalBytes' | 'filesCompleted'
  >;
  private lastBroadcastAt = 0;

  constructor(args: {
    path: string;
    label?: string;
    phase: FileTransferPhase;
    runId?: string;
    slotId?: string;
    filesTotal: number;
    totalBytes?: number;
  }) {
    this.transferId = randomUUID();
    this.filesTotal = Math.max(0, args.filesTotal);
    this.totalBytes = Math.max(0, args.totalBytes ?? 0);
    this.base = {
      transferId: this.transferId,
      path: args.path,
      label: args.label ?? basename(args.path),
      phase: args.phase,
      runId: args.runId,
      slotId: args.slotId,
      filesTotal: this.filesTotal,
      cancellable: true,
    };
    registerActive(this.transferId, {
      ...this.base,
      bytesTransferred: 0,
      totalBytes: this.totalBytes,
      filesCompleted: 0,
      state: 'running',
    });
    this.publish('running', true);
  }

  get filesDone(): number {
    return this.filesCompleted;
  }

  noteFileProgress(fileBytesTransferred: number, fileTotal: number): void {
    // Reflect last file's contribution as overall when total unknown.
    void fileTotal;
    this.bytesTransferred += 0; // per-file deltas handled via noteFileComplete
    void fileBytesTransferred;
  }

  noteFileComplete(fileSize: number): void {
    this.filesCompleted += 1;
    this.bytesTransferred += Math.max(0, fileSize);
    this.publish('running', false);
  }

  complete(): void {
    this.publish('done', true);
    unregisterActive(this.transferId);
  }

  fail(error: string): void {
    this.publish('failed', true, error);
    unregisterActive(this.transferId);
  }

  private publish(state: FileTransferState, force: boolean, error?: string): void {
    const progress: FileTransferProgress = {
      ...this.base,
      bytesTransferred: this.bytesTransferred,
      totalBytes: this.totalBytes > 0 ? this.totalBytes : this.bytesTransferred,
      filesCompleted: this.filesCompleted,
      filesTotal: this.filesTotal,
      state,
      cancellable: state === 'running',
    };
    if (error) progress.error = error;
    const now = Date.now();
    const entry = activeTransfers.get(this.transferId);
    if (entry) entry.progress = progress;
    const should =
      force ||
      state !== 'running' ||
      now - this.lastBroadcastAt >= FILE_TRANSFER_PROGRESS_BROADCAST_MIN_INTERVAL_MS;
    if (should) {
      this.lastBroadcastAt = now;
      broadcastFn(Events.FILE_TRANSFER_PROGRESS, progress);
    }
  }
}

/** Read a remote file fully into a Buffer via chunked progress-aware path. */
export async function readRemoteFileChunkedToBuffer(
  params: Omit<ChunkedCopyParams, 'localPath' | 'keepPartialOnFailure' | 'resumeFromOffset'> & {
    maxBytes?: number;
  },
): Promise<{ buffer: Buffer; sha256: string; transferId: string; size: number }> {
  const parts: Buffer[] = [];
  const transferId = params.transferId ?? randomUUID();
  const chunkMax = params.chunkMaxBytes ?? FILE_TRANSFER_CHUNK_MAX_BYTES;
  const clock = params.clock ?? realClock;
  let totalBytes = params.totalBytes ?? 0;
  const idleTimeoutMs =
    params.idleTimeoutMs ?? fileTransferIdleTimeoutMs(totalBytes > 0 ? totalBytes : chunkMax * 4);
  const label = params.label ?? basename(params.path);
  const encoding = params.encoding ?? 'base64';
  const base = {
    transferId,
    path: params.path,
    label,
    phase: params.phase,
    runId: params.runId,
    slotId: params.slotId,
    encoding,
  };
  registerActive(transferId, {
    ...base,
    bytesTransferred: 0,
    totalBytes,
    state: 'running',
    cancellable: true,
  });
  const hash = createHash('sha256');
  let bytesTransferred = 0;
  let lastProgressAt = clock.now();
  const progressEvents: FileTransferProgress[] = [];

  const publish = (state: FileTransferState, extra?: { error?: string; sha256?: string }) => {
    const progress = buildProgress(base, state, bytesTransferred, totalBytes, extra);
    progressEvents.push(progress);
    params.onProgress?.(progress);
    emitFileTransferProgress(progress, { force: state !== 'running', now: clock.now() });
    if (state === 'running') lastProgressAt = clock.now();
  };

  try {
    publish('running');
    let offset = 0;
    let eof = false;
    while (!eof) {
      if (clock.now() - lastProgressAt > idleTimeoutMs) {
        throw new FileTransferIdleTimeoutError({
          transferId,
          bytesTransferred,
          totalBytes,
          idleTimeoutMs,
        });
      }
      const chunk = await params.readChunk(offset, chunkMax);
      if (params.maxBytes != null && chunk.size > params.maxBytes) {
        throw new Error(`Remote artifact too large to proxy (${chunk.size} bytes)`);
      }
      if (chunk.offset !== offset) {
        throw new FileTransferIntegrityError(
          `Chunk offset mismatch: expected ${offset}, got ${chunk.offset}`,
        );
      }
      if (totalBytes === 0 && chunk.size > 0) totalBytes = chunk.size;
      if (chunk.bytesRead === 0) {
        eof = true;
        break;
      }
      const buf = decodeChunkContent(
        chunk.content,
        chunk.encoding ?? encoding,
        chunk.bytesRead,
        params.path,
      );
      parts.push(buf);
      hash.update(buf);
      bytesTransferred += chunk.bytesRead;
      offset += chunk.bytesRead;
      eof = chunk.eof || (totalBytes > 0 && offset >= totalBytes);
      publish('running');
    }
    if (totalBytes === 0) totalBytes = bytesTransferred;
    const sha256 = hash.digest('hex');
    if (params.expectedSha256 && params.expectedSha256 !== sha256) {
      throw new FileTransferIntegrityError(
        `Assembled sha256 ${sha256} !== expected ${params.expectedSha256}`,
      );
    }
    if (params.fetchRemoteSha256) {
      const remote = await params.fetchRemoteSha256();
      if (remote && remote !== sha256) {
        throw new FileTransferIntegrityError(`Assembled sha256 ${sha256} !== remote ${remote}`);
      }
    }
    publish('done', { sha256 });
    return { buffer: Buffer.concat(parts, bytesTransferred), sha256, transferId, size: bytesTransferred };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    publish('failed', { error: message });
    throw err;
  } finally {
    unregisterActive(transferId);
  }
}

/** Local-file chunk reader used by smoke RPC and unit tests. */
export async function readLocalFileChunk(
  filePath: string,
  offset: number,
  length: number,
  encoding: FileTransferEncoding = 'base64',
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
      encoding,
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

/** Atomically replace dest with src after a successful transfer into a temp path. */
export async function finalizeTransferTemp(tempPath: string, destPath: string): Promise<void> {
  await rename(tempPath, destPath);
}
