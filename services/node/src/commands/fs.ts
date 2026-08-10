import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';

import { expandTilde, type FileWatchHandle, watchFile } from '@farmslot/capabilities/fs-watch';
import type {
  NodeFsPathParams,
  NodeFsReadBase64Params,
  NodeFsReadChunkParams,
  NodeFsReadChunkResult,
  NodeFsRenameParams,
  NodeFsWriteFileEntry,
  NodeFsWriteFilesParams,
  NodeFsWriteParams,
} from '@farmslot/protocol';

export interface FsEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

function accessError(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'EACCES';
  return error;
}

function confinedPath(params: NodeFsPathParams): { root: string; target: string } {
  const root = resolve(expandTilde(params.root));
  if (isAbsolute(params.relPath)) throw accessError('Path traversal outside root is not allowed');
  const normalized = posix.normalize(params.relPath.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw accessError('Path traversal outside root is not allowed');
  }
  if (normalized.split('/').includes('.git')) {
    throw accessError('Access to .git is not allowed');
  }
  const target = resolve(root, normalized || '.');
  // root may already end with the separator (e.g. '/', the root the gateway
  // derives for any absolute path) — naive `root + sep` would demand '//'.
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(rootPrefix)) {
    throw accessError('Path traversal outside root is not allowed');
  }
  return { root, target };
}

function actionableNoFollowError(error: unknown, relPath: string): never {
  if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
    throw accessError(`Refusing final-component symlink: ${relPath}`);
  }
  throw error;
}

export async function fsList(params: NodeFsPathParams): Promise<{ entries: FsEntry[] }> {
  const { target } = confinedPath(params);
  const dirEntries = await readdir(target, { withFileTypes: true });
  const entries: FsEntry[] = [];
  for (const entry of dirEntries) {
    if (entry.name === '.git' || entry.name === '.' || entry.name === '..') continue;
    const fullPath = join(target, entry.name);
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, type: 'directory' });
    } else if (entry.isFile()) {
      try {
        const s = await stat(fullPath);
        entries.push({ name: entry.name, type: 'file', size: s.size });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Disappearing entries are expected while workers rewrite temp files.
        entries.push({ name: entry.name, type: 'file' });
      }
    } else if (entry.isSymbolicLink()) {
      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          entries.push({ name: entry.name, type: 'directory' });
        } else if (s.isFile()) {
          entries.push({ name: entry.name, type: 'file', size: s.size });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Broken symlinks are not actionable in the workspace tree.
      }
    }
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { entries };
}

export async function fsRead(params: NodeFsPathParams): Promise<{ content: string }> {
  const { target } = confinedPath(params);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    return { content: await handle.readFile('utf-8') };
  } catch (error) {
    return actionableNoFollowError(error, params.relPath);
  } finally {
    await handle?.close();
  }
}

export async function fsWrite(params: NodeFsWriteParams): Promise<{ ok: true }> {
  const { target } = confinedPath(params);
  let handle;
  try {
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o666,
    );
    await handle.writeFile(params.content, 'utf-8');
    return { ok: true };
  } catch (error) {
    return actionableNoFollowError(error, params.relPath);
  } finally {
    await handle?.close();
  }
}

export type FsWriteFileEntry = NodeFsWriteFileEntry;

// Batch base64 write: materializes a whole bundle (dirs + modes) under baseDir in
// one RPC instead of one mkdir/write/chmod round-trip per file. Bundles are small
// helper scripts, so a single frame is fine. Each entry path is contained to
// baseDir so a malformed relative path can't escape the incoming directory.
export async function fsWriteFiles(
  params: NodeFsWriteFilesParams,
): Promise<{ ok: true; count: number }> {
  const { target: base } = confinedPath(params);
  for (const file of params.files) {
    const nested = confinedPath({ root: base, relPath: file.path });
    const dest = nested.target;
    await mkdir(dirname(dest), { recursive: true });
    let handle;
    try {
      handle = await open(
        dest,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        file.mode ?? 0o666,
      );
      await handle.writeFile(Buffer.from(file.content, 'base64'));
      if (typeof file.mode === 'number') await handle.chmod(file.mode);
    } catch (error) {
      actionableNoFollowError(error, join(params.relPath, file.path));
    } finally {
      await handle?.close();
    }
  }
  return { ok: true, count: params.files.length };
}

export async function fsRename(params: NodeFsRenameParams): Promise<{ ok: true }> {
  const oldTarget = confinedPath({ root: params.root, relPath: params.oldRelPath }).target;
  const newTarget = confinedPath({ root: params.root, relPath: params.newRelPath }).target;
  await rename(oldTarget, newTarget);
  return { ok: true };
}

export async function fsDelete(params: NodeFsPathParams): Promise<{ ok: true }> {
  const { target } = confinedPath(params);
  await rm(target, { recursive: true });
  return { ok: true };
}

export async function fsMkdir(params: NodeFsPathParams): Promise<{ ok: true }> {
  const { target } = confinedPath(params);
  await mkdir(target, { recursive: true });
  return { ok: true };
}

export async function fsReadBase64(
  params: NodeFsReadBase64Params,
): Promise<{ content: string; size: number }> {
  const { target } = confinedPath(params);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (params.maxBytes != null && info.size > params.maxBytes) {
      throw new Error(`Remote artifact too large to proxy (${info.size} bytes)`);
    }
    const buf = await handle.readFile();
    return { content: buf.toString('base64'), size: info.size };
  } catch (error) {
    return actionableNoFollowError(error, params.relPath);
  } finally {
    await handle?.close();
  }
}

/**
 * Read a bounded byte range as base64 for progress-aware large transfers.
 * Callers must keep `length` ≤ FILE_TRANSFER_CHUNK_MAX_BYTES so frames stay
 * well under the gateway WebSocket max payload.
 */
export async function fsReadChunk(params: NodeFsReadChunkParams): Promise<NodeFsReadChunkResult> {
  if (!Number.isInteger(params.offset) || params.offset < 0) {
    throw new Error(`fs.readChunk offset must be a non-negative integer (got ${params.offset})`);
  }
  if (!Number.isInteger(params.length) || params.length <= 0) {
    throw new Error(`fs.readChunk length must be a positive integer (got ${params.length})`);
  }
  const { target } = confinedPath(params);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (params.offset > info.size) {
      throw new Error(
        `fs.readChunk offset ${params.offset} beyond file size ${info.size} for ${params.relPath}`,
      );
    }
    const toRead = Math.min(params.length, info.size - params.offset);
    const buf = Buffer.alloc(toRead);
    const { bytesRead } = await handle.read(buf, 0, toRead, params.offset);
    const slice = bytesRead === toRead ? buf : buf.subarray(0, bytesRead);
    return {
      content: slice.toString('base64'),
      size: info.size,
      offset: params.offset,
      bytesRead,
      eof: params.offset + bytesRead >= info.size,
      encoding: 'base64',
    };
  } catch (error) {
    return actionableNoFollowError(error, params.relPath);
  } finally {
    await handle?.close();
  }
}

/**
 * Write a bounded base64 chunk at an absolute offset. offset=0 with truncate creates/truncates.
 * Subsequent chunks append/overwrite at offset under path confinement.
 */
export async function fsWriteChunk(params: {
  root: string;
  relPath: string;
  offset: number;
  content: string;
  truncate?: boolean;
}): Promise<{ ok: true; bytesWritten: number; offset: number }> {
  if (!Number.isInteger(params.offset) || params.offset < 0) {
    throw new Error(`fs.writeChunk offset must be a non-negative integer (got ${params.offset})`);
  }
  const { target } = confinedPath(params);
  const buf = Buffer.from(params.content, 'base64');
  let handle;
  try {
    const flags =
      params.truncate || params.offset === 0
        ? constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW
        : constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW;
    handle = await open(target, flags, 0o666);
    // Loop until the full buffer is written — FileHandle.write may return a short write.
    let written = 0;
    while (written < buf.byteLength) {
      const result = await handle.write(
        buf,
        written,
        buf.byteLength - written,
        params.offset + written,
      );
      if (result.bytesWritten <= 0) {
        throw new Error(
          `fs.writeChunk short write at offset ${params.offset + written} (0 bytes)`,
        );
      }
      written += result.bytesWritten;
    }
    return { ok: true, bytesWritten: written, offset: params.offset };
  } catch (error) {
    return actionableNoFollowError(error, params.relPath);
  } finally {
    await handle?.close();
  }
}

export async function fsHash(params: NodeFsPathParams): Promise<{ sha256: string; size: number }> {
  const { target } = confinedPath(params);
  const hash = createHash('sha256');
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
    return { sha256: hash.digest('hex'), size: info.size };
  } catch (error) {
    return actionableNoFollowError(error, params.relPath);
  } finally {
    await handle?.close();
  }
}

export async function fsStat(
  params: NodeFsPathParams,
): Promise<{ size: number; isFile: boolean; isDirectory: boolean; mtimeMs: number }> {
  const { target } = confinedPath(params);
  // This is a metadata probe, not an acting read. lstat preserves the old
  // ability to inspect unreadable entries while avoiding symlink traversal.
  const info = await lstat(target);
  return {
    size: info.size,
    isFile: info.isFile(),
    isDirectory: info.isDirectory(),
    mtimeMs: info.mtimeMs,
  };
}

export async function fsRealpath(params: NodeFsPathParams): Promise<{ path: string }> {
  const { target } = confinedPath(params);
  return { path: await realpath(target) };
}

// Gateway calls this to check which entries under `repoPath` are gitignored.
// Pipes names via stdin (not a shell string) so filenames containing quotes,
// spaces, `$`, backticks, etc. cannot inject shell — the prior `bash -c` path
// interpolated names into single quotes and broke on any filename containing
// a `'`.
export async function fsCheckIgnore(params: {
  repoPath: string;
  names: string[];
}): Promise<{ ignored: string[] }> {
  if (params.names.length === 0) return { ignored: [] };
  const cwd = expandTilde(params.repoPath);
  return new Promise((resolve) => {
    const proc = spawn('git', ['check-ignore', '--stdin'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.on('close', () => {
      resolve({ ignored: stdout.trim().split('\n').filter(Boolean) });
    });
    proc.on('error', () => {
      resolve({ ignored: [] });
    });
    proc.stdin.write(params.names.join('\n'));
    proc.stdin.end();
  });
}

export async function fsExists(params: NodeFsPathParams): Promise<{ exists: boolean }> {
  // Keep confinement failures actionable, while preserving the historical
  // "never throws for filesystem probe failures" behavior of fs.exists.
  const { target } = confinedPath(params);
  try {
    await access(target, constants.F_OK);
    return { exists: true };
  } catch {
    return { exists: false };
  }
}

// Track active watch handles by request ID. The watch primitive itself lives in
// @farmslot/capabilities so the gateway can reuse it as a local fallback (ADR-046).
const activeWatchers = new Map<string, FileWatchHandle>();

export function fsWatchStart(
  requestId: string,
  params: { path: string },
  onChange: (content: string) => void,
): void {
  // Clean up existing watcher for this ID if any
  fsWatchStop(requestId);
  activeWatchers.set(requestId, watchFile(params.path, onChange));
}

export function fsWatchStop(requestId: string): boolean {
  const handle = activeWatchers.get(requestId);
  if (handle) {
    handle.stop();
    activeWatchers.delete(requestId);
    return true;
  }
  return false;
}

export function fsWatchStopAll(): void {
  for (const handle of activeWatchers.values()) {
    handle.stop();
  }
  activeWatchers.clear();
}
