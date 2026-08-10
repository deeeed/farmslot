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
  type FileTransferEncoding,
  fileTransferIdleTimeoutMs,
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

/** Register a cancellable transfer session (e.g. large uploads). */
export function startFileTransferSession(progress: FileTransferProgress): AbortController {
  return registerActive(progress.transferId, progress);
}

export function endFileTransferSession(transferId: string): void {
  unregisterActive(transferId);
}

export function emitFileTransferProgress(
  progress: FileTransferProgress,
  opts?: { force?: boolean; now?: number },
): void {
  const now = opts?.now ?? Date.now();
  const entry = activeTransfers.get(progress.transferId);
  const prevBytes = entry?.progress.bytesTransferred ?? 0;
  const bytesAdvanced = progress.bytesTransferred !== prevBytes;
  const filled =
    progress.state === 'running' &&
    progress.totalBytes > 0 &&
    progress.bytesTransferred >= progress.totalBytes;
  const prevPct =
    entry && entry.progress.totalBytes > 0
      ? Math.round((entry.progress.bytesTransferred / entry.progress.totalBytes) * 100)
      : 0;
  const pct =
    progress.totalBytes > 0
      ? Math.round((progress.bytesTransferred / progress.totalBytes) * 100)
      : 0;
  const pctAdvanced = pct !== prevPct;
  const intervalOk =
    !entry || now - entry.lastBroadcastAt >= FILE_TRANSFER_PROGRESS_BROADCAST_MIN_INTERVAL_MS;
  const force =
    opts?.force ||
    progress.state !== 'running' ||
    !entry ||
    filled ||
    // Emit on byte/percent advances: first non-zero, percent change, or 2Hz cadence.
    (bytesAdvanced && (intervalOk || prevBytes === 0 || pctAdvanced));
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
    // Broadcast first so emitFileTransferProgress can compare against the previous
    // active snapshot (updateActive before emit makes bytesAdvanced always false).
    emitFileTransferProgress(progress, { force, now: clock.now() });
    updateActive(progress);
  };

  let bytesTransferred = 0;
  let lastProgressAt = clock.now();
  const startedAt = clock.now();
  const hash = createHash('sha256');
  let writeStream: ReturnType<typeof createWriteStream> | null = null;
  let failed = false;
  let cancelled = false;
  const resumeFrom = Math.max(0, Math.floor(params.resumeFromOffset ?? 0));
  // Never write into the published destination until integrity succeeds — a failed
  // transfer must not delete prior-good final files; cancel keeps a sibling partial.
  const finalLocalPath = params.localPath;
  const workPath = finalLocalPath ? `${finalLocalPath}.farmslot-partial` : undefined;

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

  const idleTimeoutError = () =>
    new FileTransferIdleTimeoutError({
      transferId,
      bytesTransferred,
      totalBytes,
      idleTimeoutMs,
    });

  /** Reject if idle budget is already exhausted; race pending reads against the remainder. */
  const assertNotIdle = () => {
    if (clock.now() - lastProgressAt > idleTimeoutMs) {
      throw idleTimeoutError();
    }
  };

  const readChunkWithIdle = async (offset: number, length: number): Promise<ChunkReadResult> => {
    assertNotIdle();
    // Wall-clock budget for a hung/pending read. Fake clocks used in unit tests often
    // no-op `sleep` while advancing `now` only inside readChunk — racing clock.sleep
    // would false-trigger idle immediately. Wall time covers production RPC stalls;
    // logical idle is still enforced before/after via assertNotIdle + RPC translation.
    const remainingLogical = Math.max(1, idleTimeoutMs - (clock.now() - lastProgressAt));
    const remainingWallMs = Math.min(remainingLogical, idleTimeoutMs);
    const readPromise = params.readChunk(offset, length);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idlePromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(idleTimeoutError()), remainingWallMs);
    });
    try {
      return await Promise.race([readPromise, idlePromise]);
    } catch (err) {
      // Production node RPC can surface first as a generic 60s mini timeout — translate
      // so operators still see last-progress bytes/total (required transfer contract).
      const message = err instanceof Error ? err.message : String(err);
      if (
        !(err instanceof FileTransferIdleTimeoutError) &&
        /timeout after \d+ms|Node mini timeout|RPC timeout|request timed out/i.test(message)
      ) {
        throw idleTimeoutError();
      }
      throw err;
    } finally {
      // Cancel the idle timer when the race settles. Attach a late-read handler only
      // after settle so a still-in-flight RPC rejection is not an unhandled rejection
      // and is not observed as a silent swallowed error on the race winner path.
      if (timer) clearTimeout(timer);
      void readPromise.then(
        () => undefined,
        () => undefined,
      );
    }
  };

  try {
    if (workPath && resumeFrom > 0) {
      // Resume is always against the sibling partial. If a caller truncated the
      // published final (smoke/tests), re-stage it as the partial first.
      if (!existsSync(workPath) && finalLocalPath && existsSync(finalLocalPath)) {
        await rename(finalLocalPath, workPath);
      }
      if (!existsSync(workPath)) {
        throw new FileTransferIntegrityError(
          `Resume offset ${resumeFrom} but partial missing: ${workPath}`,
        );
      }
      const st = await stat(workPath);
      if (st.size < resumeFrom) {
        throw new FileTransferIntegrityError(
          `Partial size ${st.size} < resume offset ${resumeFrom} for ${workPath}`,
        );
      }
      // Re-hash prefix so integrity covers the full assembled file.
      const handle = await open(workPath, 'r');
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
        await truncate(workPath, resumeFrom);
      }
      bytesTransferred = resumeFrom;
      writeStream = createWriteStream(workPath, { flags: 'a' });
    } else if (workPath) {
      writeStream = createWriteStream(workPath);
    }

    publish('running', undefined, true);

    let offset = resumeFrom;
    let eof = totalBytes > 0 && offset >= totalBytes;
    while (!eof) {
      throwIfAborted();
      assertNotIdle();

      const chunk = await readChunkWithIdle(offset, chunkMax);
      throwIfAborted();
      assertNotIdle();

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
          // Drain and error are paired one-shots: remove the loser on settlement
          // so multi-chunk backpressure does not accumulate error listeners.
          await new Promise<void>((resolve, reject) => {
            const stream = writeStream!;
            const onDrain = () => {
              stream.off('error', onError);
              resolve();
            };
            const onError = (err: Error) => {
              stream.off('drain', onDrain);
              reject(err);
            };
            stream.once('drain', onDrain);
            stream.once('error', onError);
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

    // Atomic publish: only now replace any prior-good final destination.
    if (workPath && finalLocalPath) {
      await finalizeTransferTemp(workPath, finalLocalPath);
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
    // Never touch finalLocalPath here — only the sibling partial.
    if (workPath && !params.keepPartialOnFailure && !isCancel) {
      try {
        await rm(workPath, { force: true });
      } catch (cleanupErr) {
        console.warn(
          `[file-transfer] failed to remove partial ${workPath}: ${
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
  private readonly abort: AbortController;
  private terminal = false;
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
    // 0 = indeterminate (do not fake total=bytesTransferred — that paints 100% early).
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
    this.abort = registerActive(this.transferId, {
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

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  /** Throw if cancelTransfer() aborted this aggregate. */
  throwIfCancelled(): void {
    if (this.abort.signal.aborted) {
      throw new FileTransferCancelledError(this.transferId);
    }
  }

  /** Bytes from fully completed files (not including the in-flight file). */
  private completedBytes = 0;

  noteFileProgress(fileBytesTransferred: number, _fileTotal: number): void {
    this.throwIfCancelled();
    this.bytesTransferred = this.completedBytes + Math.max(0, fileBytesTransferred);
    this.publish('running', false);
  }

  noteFileComplete(fileSize: number): void {
    this.throwIfCancelled();
    this.filesCompleted += 1;
    this.completedBytes += Math.max(0, fileSize);
    this.bytesTransferred = this.completedBytes;
    this.publish('running', false);
  }

  complete(): void {
    if (this.terminal) return;
    if (this.abort.signal.aborted) {
      this.markCancelled();
      return;
    }
    this.terminal = true;
    this.publish('done', true);
    unregisterActive(this.transferId);
  }

  fail(error: string): void {
    if (this.terminal) return;
    if (this.abort.signal.aborted) {
      this.markCancelled();
      return;
    }
    this.terminal = true;
    this.publish('failed', true, error);
    unregisterActive(this.transferId);
  }

  private markCancelled(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.publish('cancelled', true, 'cancelled');
    unregisterActive(this.transferId);
  }

  private publish(state: FileTransferState, force: boolean, error?: string): void {
    const progress: FileTransferProgress = {
      ...this.base,
      bytesTransferred: this.bytesTransferred,
      // Keep unknown totals as 0 so UI reports indeterminate (0%) instead of 100%.
      totalBytes: this.totalBytes,
      filesCompleted: this.filesCompleted,
      filesTotal: this.filesTotal,
      state,
      cancellable: state === 'running',
    };
    if (error) progress.error = error;
    const now = Date.now();
    const entry = activeTransfers.get(this.transferId);
    const prevBytes = entry?.progress.bytesTransferred ?? 0;
    const prevFiles = entry?.progress.filesCompleted ?? 0;
    const bytesAdvanced = progress.bytesTransferred !== prevBytes;
    const filesAdvanced = progress.filesCompleted !== prevFiles;
    if (entry) entry.progress = progress;
    const intervalOk =
      now - this.lastBroadcastAt >= FILE_TRANSFER_PROGRESS_BROADCAST_MIN_INTERVAL_MS;
    const should =
      force ||
      state !== 'running' ||
      // First non-zero byte, percent/file advance, or 2Hz cadence.
      (bytesAdvanced && (intervalOk || prevBytes === 0)) ||
      (filesAdvanced && intervalOk);
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
  const sessionAbort = registerActive(transferId, {
    ...base,
    bytesTransferred: 0,
    totalBytes,
    state: 'running',
    cancellable: true,
  });
  const combinedSignal = params.abortSignal
    ? mergeAbortSignals(params.abortSignal, sessionAbort.signal)
    : sessionAbort.signal;
  const hash = createHash('sha256');
  let bytesTransferred = 0;
  let lastProgressAt = clock.now();
  const progressEvents: FileTransferProgress[] = [];

  const publish = (state: FileTransferState, extra?: { error?: string; sha256?: string }) => {
    const progress = buildProgress(base, state, bytesTransferred, totalBytes, extra);
    progressEvents.push(progress);
    params.onProgress?.(progress);
    // Compare against previous snapshot before replacing it.
    emitFileTransferProgress(progress, { force: state !== 'running', now: clock.now() });
    updateActive(progress);
    if (state === 'running') lastProgressAt = clock.now();
  };

  const idleTimeoutError = () =>
    new FileTransferIdleTimeoutError({
      transferId,
      bytesTransferred,
      totalBytes,
      idleTimeoutMs,
    });

  const assertNotIdle = () => {
    if (clock.now() - lastProgressAt > idleTimeoutMs) {
      throw idleTimeoutError();
    }
  };

  // Same idle race + RPC-timeout translation as copyFileChunked (HTTP/proxy path).
  const readChunkWithIdle = async (offset: number, length: number): Promise<ChunkReadResult> => {
    assertNotIdle();
    const remainingLogical = Math.max(1, idleTimeoutMs - (clock.now() - lastProgressAt));
    const remainingWallMs = Math.min(remainingLogical, idleTimeoutMs);
    const readPromise = params.readChunk(offset, length);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idlePromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(idleTimeoutError()), remainingWallMs);
    });
    try {
      return await Promise.race([readPromise, idlePromise]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        !(err instanceof FileTransferIdleTimeoutError) &&
        /timeout after \d+ms|Node mini timeout|RPC timeout|request timed out/i.test(message)
      ) {
        throw idleTimeoutError();
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      void readPromise.then(
        () => undefined,
        () => undefined,
      );
    }
  };

  try {
    publish('running');
    let offset = 0;
    let eof = false;
    while (!eof) {
      if (combinedSignal.aborted) {
        throw new FileTransferCancelledError(transferId);
      }
      assertNotIdle();
      const chunk = await readChunkWithIdle(offset, chunkMax);
      if (combinedSignal.aborted) {
        throw new FileTransferCancelledError(transferId);
      }
      assertNotIdle();
      if (params.maxBytes != null && chunk.size > params.maxBytes) {
        throw new Error(`Remote artifact too large to proxy (${chunk.size} bytes)`);
      }
      if (chunk.offset !== offset) {
        throw new FileTransferIntegrityError(
          `Chunk offset mismatch: expected ${offset}, got ${chunk.offset}`,
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
            `Early EOF at offset ${offset} of ${totalBytes} for ${params.path}`,
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
      parts.push(buf);
      hash.update(buf);
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
    const cancelled =
      err instanceof FileTransferCancelledError || combinedSignal.aborted;
    const message = err instanceof Error ? err.message : String(err);
    publish(cancelled ? 'cancelled' : 'failed', { error: message });
    throw cancelled && !(err instanceof FileTransferCancelledError)
      ? new FileTransferCancelledError(transferId)
      : err;
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
