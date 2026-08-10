// slot-io.ts — Transport abstraction for local/remote slot file operations.
// Local: Node fs. Remote: agent RPC or SSH.
// All functions accept a SlotLocality context (SlotVars satisfies this).

import { existsSync } from 'node:fs';
import {
  chmod as fsChmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import path from 'node:path';

import { type FSWatcher, watch } from 'chokidar';

import {
  FILE_TRANSFER_CHUNK_MAX_BYTES,
  FILE_TRANSFER_CHUNK_RPC_TIMEOUT_MS,
  FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES,
  type FileTransferPhase,
  type NodeFsReadChunkResult,
} from '@farmslot/protocol';

import { getNode } from '../fleet/machine-registry.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';

import { isLocal } from './exec.js';
import {
  AggregateTransferSession,
  copyFileChunked,
  readRemoteFileChunkedToBuffer,
} from './file-transfer.js';

export const MAX_ARTIFACT_TREE_DEPTH = 12;
// Subset of SlotVars — SlotVars satisfies this via structural typing
export interface SlotLocality {
  host: string;
  machine: string;
  sshTarget: string;
}

export interface SlotCopyDirOptions {
  excludeTopLevel?: string[];
  excludeRelativePaths?: string[];
  /**
   * When set, per-file copy failures are reported via the callback and the
   * walk continues. Without this, the first per-file failure throws
   * SlotCopyDirEntryError. Use for best-effort artifact collection (slot.release)
   * where one transient EACCES on a screenshot must not abort the whole copy.
   */
  onEntryFailure?: (err: SlotCopyDirEntryError) => void;
  /** Progress phase for large remote files (default download). */
  phase?: FileTransferPhase;
  runId?: string;
  slotId?: string;
  labelPrefix?: string;
}

export class SlotCopyDirEntryError extends Error {
  readonly sourcePath: string;
  readonly targetPath: string;
  override readonly cause: unknown;

  constructor(sourcePath: string, targetPath: string, cause: unknown) {
    super(
      `slotCopyDir failed to copy file ${sourcePath} -> ${targetPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'SlotCopyDirEntryError';
    this.sourcePath = sourcePath;
    this.targetPath = targetPath;
    this.cause = cause;
  }
}

function local(ctx: SlotLocality): boolean {
  return isLocal(ctx.host, ctx.machine);
}

function requireNode(machine: string) {
  const node = getNode(machine);
  if (!node) throw new Error(`No node connected for ${machine}`);
  return node;
}

function nodePathParams(fullPath: string): { root: string; relPath: string } {
  // '~' is resolved by the node's own expandTilde (commands/fs.ts confinedPath),
  // so home-relative paths like ~/farmslot-node/support/... are valid remote
  // roots — the gateway cannot expand them because the remote home is unknown here.
  if (fullPath === '~' || fullPath.startsWith('~/')) {
    return { root: '~', relPath: fullPath === '~' ? '' : fullPath.slice(2) };
  }
  const root = path.parse(fullPath).root;
  if (!root) throw new Error(`Remote slot path must be absolute: ${fullPath}`);
  return { root, relPath: path.relative(root, fullPath) };
}

async function assertConcreteDirRoot(
  dirPath: string,
  resolvePath: (inputPath: string) => Promise<string>,
): Promise<void> {
  const [resolvedDirPath, resolvedParentPath] = await Promise.all([
    resolvePath(dirPath),
    resolvePath(path.dirname(dirPath)),
  ]);
  const expectedResolvedDirPath = path.join(resolvedParentPath, path.basename(dirPath));
  if (resolvedDirPath !== expectedResolvedDirPath) {
    throw new Error(`slotCopyDir refuses symlinked root ${dirPath}`);
  }
}

// ─── slotReadFile ───

export async function slotReadFile(ctx: SlotLocality, filePath: string): Promise<string> {
  if (local(ctx)) {
    return readFile(filePath, 'utf-8');
  }
  const result = (await sendNodeRequest(requireNode(ctx.machine), 'fs.read', {
    ...nodePathParams(filePath),
  })) as { content: string };
  return result.content;
}

export async function slotRealpath(ctx: SlotLocality, filePath: string): Promise<string> {
  if (local(ctx)) return realpath(filePath);
  const result = (await sendNodeRequest(requireNode(ctx.machine), 'fs.realpath', {
    ...nodePathParams(filePath),
  })) as { path: string };
  return result.path;
}

// ─── slotFileExists ───

export async function slotFileExists(ctx: SlotLocality, filePath: string): Promise<boolean> {
  if (local(ctx)) {
    return existsSync(filePath);
  }
  const result = (await sendNodeRequest(requireNode(ctx.machine), 'fs.exists', {
    ...nodePathParams(filePath),
  })) as { exists: boolean };
  return result.exists;
}

// ─── slotListDir ───

export async function slotListDir(ctx: SlotLocality, dirPath: string): Promise<string[]> {
  if (local(ctx)) {
    return readdir(dirPath);
  }
  const result = (await sendNodeRequest(requireNode(ctx.machine), 'fs.list', {
    ...nodePathParams(dirPath),
  })) as { entries: Array<{ name: string }> };
  return result.entries.map((e) => e.name);
}

// ─── slotWriteFile ───

export async function slotWriteFile(
  ctx: SlotLocality,
  filePath: string,
  data: string,
): Promise<void> {
  if (local(ctx)) {
    await fsWriteFile(filePath, data, 'utf-8');
    return;
  }
  await sendNodeRequest(requireNode(ctx.machine), 'fs.write', {
    ...nodePathParams(filePath),
    content: data,
  });
}

export interface SlotWriteFileEntry {
  /** Path relative to baseDir. */
  path: string;
  /** Base64-encoded file content. */
  content: string;
  /** Octal file mode (e.g. 0o755); left unchanged when omitted. */
  mode?: number;
}

// Batch base64 write: materializes a whole file set under baseDir (creating
// parent dirs and applying modes) in a single node RPC, instead of a mkdir +
// write + chmod round-trip per file.
export async function slotWriteFiles(
  ctx: SlotLocality,
  baseDir: string,
  files: SlotWriteFileEntry[],
): Promise<void> {
  if (local(ctx)) {
    for (const file of files) {
      const dest = path.join(baseDir, file.path);
      await mkdir(path.dirname(dest), { recursive: true });
      await fsWriteFile(dest, Buffer.from(file.content, 'base64'));
      if (typeof file.mode === 'number') await fsChmod(dest, file.mode);
    }
    return;
  }
  await sendNodeRequest(requireNode(ctx.machine), 'fs.writeFiles', {
    root: baseDir,
    relPath: '.',
    files,
  });
}

// ─── slotMkdir / slotDeletePath / slotStat ───

export async function slotMkdir(ctx: SlotLocality, dirPath: string): Promise<void> {
  if (local(ctx)) {
    await mkdir(dirPath, { recursive: true });
    return;
  }
  await sendNodeRequest(requireNode(ctx.machine), 'fs.mkdir', { ...nodePathParams(dirPath) });
}

export async function slotDeletePath(ctx: SlotLocality, targetPath: string): Promise<void> {
  if (local(ctx)) {
    await rm(targetPath, { recursive: true, force: true });
    return;
  }
  await sendNodeRequest(requireNode(ctx.machine), 'fs.delete', { ...nodePathParams(targetPath) });
}

export interface SlotStatResult {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  mtimeMs: number;
}

export async function slotStat(ctx: SlotLocality, targetPath: string): Promise<SlotStatResult> {
  if (local(ctx)) {
    const info = await lstat(targetPath);
    return {
      size: info.size,
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      mtimeMs: info.mtimeMs,
    };
  }
  return (await sendNodeRequest(requireNode(ctx.machine), 'fs.stat', {
    ...nodePathParams(targetPath),
  })) as SlotStatResult;
}

// ─── slotCopyFile ───
// Copy a single file from slot to a local destination.
// Local: fs.copyFile. Remote: small files one-shot fs.readBase64; large files
// go through chunked fs.readChunk with progress events and idle-based timeouts.

export interface SlotCopyFileOptions {
  label?: string;
  phase?: FileTransferPhase;
  runId?: string;
  slotId?: string;
  parentTransferId?: string;
  filesCompleted?: number;
  filesTotal?: number;
  /** Force chunked path even for small files (tests). */
  forceChunked?: boolean;
  /** Override small-file threshold (tests). */
  smallFileThresholdBytes?: number;
  resumeFromOffset?: number;
  keepPartialOnFailure?: boolean;
  /** Verify assembled bytes against remote fs.hash when true (default for chunked). */
  verifyRemoteHash?: boolean;
  onProgress?: (progress: import('@farmslot/protocol').FileTransferProgress) => void;
  /** Parent aggregate / operator cancel signal. */
  abortSignal?: AbortSignal;
}

export async function slotCopyFile(
  ctx: SlotLocality,
  remotePath: string,
  localPath: string,
  options: SlotCopyFileOptions = {},
): Promise<void> {
  if (local(ctx)) {
    await copyFile(remotePath, localPath);
    return;
  }
  const node = requireNode(ctx.machine);
  const pathParams = nodePathParams(remotePath);
  const threshold = options.smallFileThresholdBytes ?? FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES;

  let size = 0;
  try {
    const st = (await sendNodeRequest(node, 'fs.stat', pathParams, {
      timeout: FILE_TRANSFER_CHUNK_RPC_TIMEOUT_MS,
    })) as { size: number; isFile: boolean };
    size = st.size;
    if (!st.isFile) {
      // Authoritative metadata — never fall through to one-shot file read.
      throw new Error(`slotCopyFile remote path is not a file: ${remotePath}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Only swallow transport/stat unavailability. "not a file" and forceChunked stay hard.
    if (options.forceChunked || message.includes('is not a file')) throw err;
  }

  const useChunked = options.forceChunked || size > threshold;
  if (!useChunked) {
    const result = (await sendNodeRequest(node, 'fs.readBase64', pathParams, {
      timeout: FILE_TRANSFER_CHUNK_RPC_TIMEOUT_MS,
    })) as { content: string };
    await fsWriteFile(localPath, Buffer.from(result.content, 'base64'));
    return;
  }

  const verifyHash = options.verifyRemoteHash !== false;
  await copyFileChunked({
    path: remotePath,
    label: options.label ?? path.basename(remotePath),
    phase: options.phase ?? 'download',
    runId: options.runId,
    slotId: options.slotId,
    parentTransferId: options.parentTransferId,
    filesCompleted: options.filesCompleted,
    filesTotal: options.filesTotal,
    totalBytes: size > 0 ? size : undefined,
    localPath,
    resumeFromOffset: options.resumeFromOffset,
    keepPartialOnFailure: options.keepPartialOnFailure,
    onProgress: options.onProgress,
    abortSignal: options.abortSignal,
    fetchRemoteSha256: verifyHash
      ? async () => {
          const hashed = (await sendNodeRequest(node, 'fs.hash', pathParams, {
            timeout: FILE_TRANSFER_CHUNK_RPC_TIMEOUT_MS,
          })) as { sha256: string };
          return hashed.sha256;
        }
      : undefined,
    readChunk: async (offset, length) => {
      const chunk = (await sendNodeRequest(
        node,
        'fs.readChunk',
        { ...pathParams, offset, length },
        { timeout: FILE_TRANSFER_CHUNK_RPC_TIMEOUT_MS },
      )) as NodeFsReadChunkResult;
      return chunk;
    },
  });
}

export type SlotReadFileTransportMode = 'local' | 'oneshot' | 'chunked';

export interface SlotReadFileTransportInfo {
  mode: SlotReadFileTransportMode;
  /** Node `fs.readChunk` RPC count (0 for local/oneshot). */
  readChunkCount: number;
  /** Confined node RPC root used for remote reads. */
  root?: string;
  relPath?: string;
}

/**
 * Read a remote file into a Buffer with progress (HTTP artifact proxy, etc.).
 * Small files still use one-shot readBase64.
 *
 * Prefer `root` + `relPath` for remote routes so node confinement stays at the
 * repository/artifact boundary instead of collapsing to filesystem root `/`.
 */
export async function slotReadFileBuffer(
  ctx: SlotLocality,
  remotePath: string,
  options: {
    label?: string;
    phase?: FileTransferPhase;
    runId?: string;
    slotId?: string;
    maxBytes?: number;
    forceChunked?: boolean;
    /** Bounded node root (repository or artifact dir). Requires relPath. */
    root?: string;
    /** Path relative to root. Requires root. */
    relPath?: string;
    onProgress?: (progress: import('@farmslot/protocol').FileTransferProgress) => void;
    /** Observability for HTTP/recipe proofs that chunking actually ran. */
    onTransport?: (info: SlotReadFileTransportInfo) => void;
  } = {},
): Promise<Buffer> {
  if (local(ctx)) {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(remotePath);
    if (options.maxBytes != null && buf.byteLength > options.maxBytes) {
      throw new Error(`Remote artifact too large to proxy (${buf.byteLength} bytes)`);
    }
    options.onTransport?.({ mode: 'local', readChunkCount: 0 });
    return buf;
  }
  const node = requireNode(ctx.machine);
  if ((options.root == null) !== (options.relPath == null)) {
    throw new Error('slotReadFileBuffer remote root and relPath must be provided together');
  }
  const pathParams =
    options.root != null && options.relPath != null
      ? { root: options.root, relPath: options.relPath }
      : nodePathParams(remotePath);
  let size = 0;
  try {
    const st = (await sendNodeRequest(node, 'fs.stat', pathParams, {
      timeout: FILE_TRANSFER_CHUNK_RPC_TIMEOUT_MS,
    })) as { size: number };
    size = st.size;
  } catch (err) {
    // Stat is best-effort unless the caller requires the chunked path.
    if (options.forceChunked) throw err;
  }
  // Must not live inside the stat try/catch — oversize is a hard failure for proxies.
  if (options.maxBytes != null && size > options.maxBytes) {
    throw new Error(`Remote artifact too large to proxy (${size} bytes)`);
  }
  const threshold = FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES;
  // One-shot for known-small OR unknown size (stat missed). Known-large uses chunked progress.
  if (!options.forceChunked && (size === 0 || size <= threshold)) {
    const result = (await sendNodeRequest(node, 'fs.readBase64', {
      ...pathParams,
      maxBytes: options.maxBytes,
    }, {
      timeout: FILE_TRANSFER_CHUNK_RPC_TIMEOUT_MS,
    })) as { content: string };
    options.onTransport?.({
      mode: 'oneshot',
      readChunkCount: 0,
      root: pathParams.root,
      relPath: pathParams.relPath,
    });
    return Buffer.from(result.content, 'base64');
  }
  let readChunkCount = 0;
  const { buffer } = await readRemoteFileChunkedToBuffer({
    path: remotePath,
    label: options.label ?? path.basename(remotePath),
    phase: options.phase ?? 'download',
    runId: options.runId,
    slotId: options.slotId,
    totalBytes: size > 0 ? size : undefined,
    maxBytes: options.maxBytes,
    onProgress: options.onProgress,
    readChunk: async (offset, length) => {
      readChunkCount += 1;
      return (await sendNodeRequest(
        node,
        'fs.readChunk',
        { ...pathParams, offset, length },
        { timeout: FILE_TRANSFER_CHUNK_RPC_TIMEOUT_MS },
      )) as NodeFsReadChunkResult;
    },
  });
  options.onTransport?.({
    mode: 'chunked',
    readChunkCount,
    root: pathParams.root,
    relPath: pathParams.relPath,
  });
  return buffer;
}

/** Upload a large buffer to a remote slot path with progress events. */
export async function slotWriteFileBuffer(
  ctx: SlotLocality,
  remotePath: string,
  data: Buffer,
  options: {
    label?: string;
    phase?: FileTransferPhase;
    runId?: string;
    slotId?: string;
    /** File mode (e.g. 0o600 for terminal attachments). Applied local and remote. */
    mode?: number;
  } = {},
): Promise<void> {
  if (local(ctx)) {
    await fsWriteFile(
      remotePath,
      data,
      typeof options.mode === 'number' ? { mode: options.mode } : undefined,
    );
    if (typeof options.mode === 'number') {
      await fsChmod(remotePath, options.mode);
    }
    return;
  }
  const node = requireNode(ctx.machine);
  const pathParams = nodePathParams(remotePath);
  const totalBytes = data.byteLength;
  const modePayload =
    typeof options.mode === 'number' && Number.isInteger(options.mode)
      ? { mode: options.mode }
      : {};
  if (totalBytes <= FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES) {
    const written = (await sendNodeRequest(
      node,
      'fs.writeChunk',
      {
        ...pathParams,
        offset: 0,
        content: data.toString('base64'),
        truncate: true,
        ...modePayload,
      },
      { timeout: FILE_TRANSFER_CHUNK_RPC_TIMEOUT_MS },
    )) as { bytesWritten?: number };
    if (
      typeof written.bytesWritten === 'number' &&
      written.bytesWritten !== totalBytes
    ) {
      throw new Error(
        `fs.writeChunk short write: got ${written.bytesWritten}, expected ${totalBytes}`,
      );
    }
    return;
  }
  const { randomUUID } = await import('node:crypto');
  const {
    emitFileTransferProgress,
    endFileTransferSession,
    FileTransferCancelledError,
    startFileTransferSession,
  } = await import('./file-transfer.js');
  const transferId = randomUUID();
  const label = options.label ?? path.basename(remotePath);
  const phase = options.phase ?? 'upload';
  let bytesTransferred = 0;
  const abort = startFileTransferSession({
    transferId,
    path: remotePath,
    label,
    phase,
    runId: options.runId,
    slotId: options.slotId,
    bytesTransferred: 0,
    totalBytes,
    state: 'running',
    cancellable: true,
  });
  const publish = (
    state: 'running' | 'done' | 'failed' | 'cancelled',
    error?: string,
  ) => {
    emitFileTransferProgress(
      {
        transferId,
        path: remotePath,
        label,
        phase,
        runId: options.runId,
        slotId: options.slotId,
        bytesTransferred,
        totalBytes,
        state,
        error,
        cancellable: state === 'running',
      },
      { force: true },
    );
  };
  try {
    publish('running');
    let offset = 0;
    while (offset < totalBytes) {
      if (abort.signal.aborted) {
        throw new FileTransferCancelledError(transferId);
      }
      const end = Math.min(offset + FILE_TRANSFER_CHUNK_MAX_BYTES, totalBytes);
      const slice = data.subarray(offset, end);
      const written = (await sendNodeRequest(
        node,
        'fs.writeChunk',
        {
          ...pathParams,
          offset,
          content: slice.toString('base64'),
          truncate: offset === 0,
          ...modePayload,
        },
        { timeout: FILE_TRANSFER_CHUNK_RPC_TIMEOUT_MS },
      )) as { bytesWritten?: number };
      if (
        typeof written.bytesWritten === 'number' &&
        written.bytesWritten !== slice.byteLength
      ) {
        throw new Error(
          `fs.writeChunk short write at offset ${offset}: got ${written.bytesWritten}, expected ${slice.byteLength}`,
        );
      }
      offset = end;
      bytesTransferred = offset;
      publish('running');
    }
    publish('done');
  } catch (err) {
    const cancelled =
      err instanceof FileTransferCancelledError || abort.signal.aborted;
    publish(
      cancelled ? 'cancelled' : 'failed',
      err instanceof Error ? err.message : String(err),
    );
    throw cancelled && !(err instanceof FileTransferCancelledError)
      ? new FileTransferCancelledError(transferId)
      : err;
  } finally {
    endFileTransferSession(transferId);
  }
}

/** Exported for tests asserting the chunk budget stays under the WS max payload. */
export { FILE_TRANSFER_CHUNK_MAX_BYTES };

// ─── slotCopyDir ───
// Copy a directory from slot to a local destination.
// Local: manual walk so the return value is the number of files copied.
// Remote: recursively walk via agent fs.list → fs.readBase64.

async function copyLocalRecursive(
  rootDir: string,
  sourceDir: string,
  targetDir: string,
  excluded: Set<string>,
  excludedRelativePaths: Set<string>,
  depth: number,
  onEntryFailure?: (err: SlotCopyDirEntryError) => void,
): Promise<number> {
  if (depth > MAX_ARTIFACT_TREE_DEPTH) {
    throw new Error(`slotCopyDir exceeded max recursion depth under ${sourceDir}`);
  }
  const entries = await readdir(sourceDir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (depth === 0 && excluded.has(entry.name)) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (isExcludedRelativePath(rootDir, sourcePath, excludedRelativePaths)) continue;
    if (entry.isSymbolicLink()) {
      console.log(`[slot-io] skipping symlink ${sourcePath}`);
      continue;
    }
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      count += await copyLocalRecursive(
        rootDir,
        sourcePath,
        targetPath,
        excluded,
        excludedRelativePaths,
        depth + 1,
        onEntryFailure,
      );
      continue;
    }
    if (entry.isFile()) {
      try {
        await copyFile(sourcePath, targetPath);
        count += 1;
      } catch (err) {
        const entryError = new SlotCopyDirEntryError(sourcePath, targetPath, err);
        if (onEntryFailure) {
          onEntryFailure(entryError);
          continue;
        }
        throw entryError;
      }
      continue;
    }
    // Ignore sockets/fifos/blockdev/chardev — never appear in artifact trees.
  }
  return count;
}

function normalizeRelativeCopyPath(relativePath: string): string {
  return relativePath.split(path.sep).join('/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function isExcludedRelativePath(
  rootDir: string,
  sourcePath: string,
  excludedRelativePaths: Set<string>,
): boolean {
  if (excludedRelativePaths.size === 0) return false;
  const relativePath = normalizeRelativeCopyPath(path.relative(rootDir, sourcePath));
  for (const excludedPath of excludedRelativePaths) {
    if (relativePath === excludedPath || relativePath.startsWith(`${excludedPath}/`)) return true;
  }
  return false;
}

export async function slotCopyDir(
  ctx: SlotLocality,
  remoteDir: string,
  localDir: string,
  options: SlotCopyDirOptions = {},
): Promise<number> {
  if (local(ctx)) {
    if (!existsSync(remoteDir)) return 0;
    const rootStats = await lstat(remoteDir).catch(() => null);
    if (rootStats?.isSymbolicLink()) {
      throw new Error(`slotCopyDir refuses symlinked root ${remoteDir}`);
    }
    const excluded = new Set(options.excludeTopLevel ?? []);
    const excludedRelativePaths = new Set(
      (options.excludeRelativePaths ?? []).map(normalizeRelativeCopyPath),
    );
    await mkdir(localDir, { recursive: true });
    return copyLocalRecursive(
      remoteDir,
      remoteDir,
      localDir,
      excluded,
      excludedRelativePaths,
      0,
      options.onEntryFailure,
    );
  }

  // Check remote dir exists
  if (!(await slotFileExists(ctx, remoteDir))) return 0;

  const node = requireNode(ctx.machine);
  await assertConcreteDirRoot(remoteDir, async (inputPath) => {
    const result = (await sendNodeRequest(node, 'fs.realpath', {
      ...nodePathParams(inputPath),
    })) as {
      path: string;
    };
    return result.path;
  });
  await mkdir(localDir, { recursive: true });
  const excluded = new Set(options.excludeTopLevel ?? []);
  const excludedRelativePaths = new Set(
    (options.excludeRelativePaths ?? []).map(normalizeRelativeCopyPath),
  );

  async function countRemoteFiles(
    sourceDir: string,
    depth: number,
  ): Promise<{ files: number; bytes: number }> {
    if (depth > MAX_ARTIFACT_TREE_DEPTH) return { files: 0, bytes: 0 };
    const listResult = (await sendNodeRequest(node, 'fs.list', {
      root: remoteDir,
      relPath: path.relative(remoteDir, sourceDir) || '.',
    })) as { entries: Array<{ name: string; type: string; size?: number }> };
    let files = 0;
    let bytes = 0;
    for (const entry of listResult.entries) {
      if (depth === 0 && excluded.has(entry.name)) continue;
      const sourcePath = path.join(sourceDir, entry.name);
      if (isExcludedRelativePath(remoteDir, sourcePath, excludedRelativePaths)) continue;
      if (entry.type === 'file') {
        files += 1;
        if (typeof entry.size === 'number' && entry.size > 0) bytes += entry.size;
      } else if (entry.type === 'directory' || entry.type === 'dir') {
        const nested = await countRemoteFiles(sourcePath, depth + 1);
        files += nested.files;
        bytes += nested.bytes;
      }
    }
    return { files, bytes };
  }

  const totals = await countRemoteFiles(remoteDir, 0);
  const filesTotal = totals.files;
  const aggregate = new AggregateTransferSession({
    path: remoteDir,
    label: options.labelPrefix ?? path.basename(remoteDir),
    phase: options.phase ?? 'download',
    runId: options.runId,
    slotId: options.slotId,
    filesTotal,
    totalBytes: totals.bytes > 0 ? totals.bytes : undefined,
  });

  async function copyRecursive(
    sourceDir: string,
    targetDir: string,
    depth: number,
  ): Promise<number> {
    if (depth > MAX_ARTIFACT_TREE_DEPTH) {
      throw new Error(`slotCopyDir exceeded max recursion depth under ${sourceDir}`);
    }
    aggregate.throwIfCancelled();
    const listResult = (await sendNodeRequest(node, 'fs.list', {
      root: remoteDir,
      relPath: path.relative(remoteDir, sourceDir) || '.',
    })) as {
      entries: Array<{ name: string; type: string; size?: number }>;
    };

    let count = 0;
    for (const entry of listResult.entries) {
      aggregate.throwIfCancelled();
      if (depth === 0 && excluded.has(entry.name)) continue;
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      if (isExcludedRelativePath(remoteDir, sourcePath, excludedRelativePaths)) continue;
      const normalizedSource = path.resolve(sourcePath);
      const normalizedRoot = path.resolve(remoteDir);
      if (
        !(
          normalizedSource === normalizedRoot ||
          normalizedSource.startsWith(`${normalizedRoot}${path.sep}`)
        )
      ) {
        throw new Error(`slotCopyDir encountered out-of-root path ${sourcePath}`);
      }
      if (entry.type === 'file') {
        try {
          await slotCopyFile(ctx, sourcePath, targetPath, {
            phase: options.phase ?? 'download',
            label: options.labelPrefix
              ? `${options.labelPrefix}/${path.relative(remoteDir, sourcePath)}`
              : path.relative(remoteDir, sourcePath),
            runId: options.runId,
            slotId: options.slotId,
            parentTransferId: aggregate.transferId,
            filesCompleted: aggregate.filesDone,
            filesTotal,
            abortSignal: aggregate.signal,
            onProgress: (p) => {
              if (p.state === 'running') {
                aggregate.noteFileProgress(p.bytesTransferred, p.totalBytes);
              }
            },
          });
          aggregate.noteFileComplete(typeof entry.size === 'number' ? entry.size : 0);
        } catch (err) {
          const { FileTransferCancelledError } = await import('./file-transfer.js');
          if (err instanceof FileTransferCancelledError || aggregate.signal.aborted) {
            aggregate.fail(err instanceof Error ? err.message : String(err));
            throw err instanceof FileTransferCancelledError
              ? err
              : new FileTransferCancelledError(aggregate.transferId);
          }
          const entryError = new SlotCopyDirEntryError(sourcePath, targetPath, err);
          if (options.onEntryFailure) {
            options.onEntryFailure(entryError);
            continue;
          }
          aggregate.fail(entryError.message);
          throw entryError;
        }
        count++;
        continue;
      }

      if (entry.type === 'symlink') {
        console.log(`[slot-io] skipping symlink ${sourcePath}`);
        continue;
      }

      if (entry.type === 'directory' || entry.type === 'dir') {
        await mkdir(targetPath, { recursive: true });
        count += await copyRecursive(sourcePath, targetPath, depth + 1);
        continue;
      }

      throw new Error(
        `slotCopyDir encountered unsupported entry type '${entry.type}' at ${sourcePath}`,
      );
    }
    return count;
  }

  try {
    const copied = await copyRecursive(remoteDir, localDir, 0);
    // Yield so observers (UI / listActiveTransfers) can sample final filesCompleted
    // before the aggregate unregisters on complete().
    await new Promise<void>((resolve) => setImmediate(resolve));
    aggregate.complete();
    return copied;
  } catch (err) {
    // Always terminate/unregister the aggregate — cancel and non-file errors alike.
    aggregate.fail(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

// ─── slotWatchFile ───

export function slotWatchFile(
  ctx: SlotLocality,
  filePath: string,
  cb: (content?: string) => void,
): FSWatcher | undefined {
  if (!local(ctx)) return undefined; // remote uses agent fs.watch — handled by caller
  const w = watch(filePath, { persistent: false, ignoreInitial: true });
  w.on('change', () => cb());
  w.on('add', () => cb());
  return w;
}
