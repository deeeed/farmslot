import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { expandTilde, type FileWatchHandle, watchFile } from '@farmslot/capabilities/fs-watch';

export interface FsEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

type ConfinedPath = { root: string; relPath: string };

function resolveConfinedPath(params: ConfinedPath): { root: string; target: string } {
  const root = resolve(expandTilde(params.root));
  const target = resolve(root, params.relPath || '.');
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.split(sep).includes('.git')) {
    const error = new Error(
      'Path traversal or .git access is not allowed',
    ) as NodeJS.ErrnoException;
    error.code = 'EACCES';
    throw error;
  }
  return { root, target };
}

function actionableNoFollowError(error: unknown, relPath: string): never {
  if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
    throw new Error(`Final-component symlink is not allowed: ${relPath}`, { cause: error });
  }
  throw error;
}

export async function fsList(params: ConfinedPath): Promise<{ entries: FsEntry[] }> {
  const { target } = resolveConfinedPath(params);
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

export async function fsRead(params: ConfinedPath): Promise<{ content: string }> {
  const { target } = resolveConfinedPath(params);
  try {
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return { content: await handle.readFile('utf-8') };
    } finally {
      await handle.close();
    }
  } catch (error) {
    actionableNoFollowError(error, params.relPath);
  }
}

export async function fsWrite(params: ConfinedPath & { content: string }): Promise<{ ok: true }> {
  const { target } = resolveConfinedPath(params);
  try {
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    );
    try {
      await handle.writeFile(params.content, 'utf-8');
      return { ok: true };
    } finally {
      await handle.close();
    }
  } catch (error) {
    actionableNoFollowError(error, params.relPath);
  }
}

export interface FsWriteFileEntry {
  path: string;
  content: string;
  mode?: number;
}

// Batch base64 write: materializes a whole bundle (dirs + modes) under baseDir in
// one RPC instead of one mkdir/write/chmod round-trip per file. Bundles are small
// helper scripts, so a single frame is fine. Each entry path is contained to
// baseDir so a malformed relative path can't escape the incoming directory.
export async function fsWriteFiles(params: {
  root: string;
  relPath: string;
  files: FsWriteFileEntry[];
}): Promise<{ ok: true; count: number }> {
  const { target: base } = resolveConfinedPath(params);
  for (const file of params.files) {
    const dest = resolve(join(base, file.path));
    if (dest !== base && !dest.startsWith(base + sep)) {
      throw new Error(`fs.writeFiles refuses path escaping baseDir: ${file.path}`);
    }
    const relToRoot = relative(resolve(expandTilde(params.root)), dest);
    resolveConfinedPath({ root: params.root, relPath: relToRoot });
    await mkdir(dirname(dest), { recursive: true });
    try {
      const handle = await open(
        dest,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      );
      try {
        await handle.writeFile(Buffer.from(file.content, 'base64'));
        if (typeof file.mode === 'number') await handle.chmod(file.mode);
      } finally {
        await handle.close();
      }
    } catch (error) {
      actionableNoFollowError(error, file.path);
    }
  }
  return { ok: true, count: params.files.length };
}

export async function fsRename(params: {
  root: string;
  oldRelPath: string;
  newRelPath: string;
}): Promise<{ ok: true }> {
  const oldPath = resolveConfinedPath({ root: params.root, relPath: params.oldRelPath }).target;
  const newPath = resolveConfinedPath({ root: params.root, relPath: params.newRelPath }).target;
  await rename(oldPath, newPath);
  return { ok: true };
}

export async function fsDelete(params: ConfinedPath): Promise<{ ok: true }> {
  const { target } = resolveConfinedPath(params);
  const info = await lstat(target);
  if (info.isSymbolicLink())
    actionableNoFollowError(Object.assign(new Error(), { code: 'ELOOP' }), params.relPath);
  await rm(target, { recursive: true });
  return { ok: true };
}

export async function fsMkdir(params: ConfinedPath): Promise<{ ok: true }> {
  const { target } = resolveConfinedPath(params);
  await mkdir(target, { recursive: true });
  return { ok: true };
}

export async function fsReadBase64(
  params: ConfinedPath & { maxBytes?: number },
): Promise<{ content: string; size: number }> {
  const { target } = resolveConfinedPath(params);
  try {
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (params.maxBytes != null && info.size > params.maxBytes) {
        const error = new Error(
          `File exceeds maximum size of ${params.maxBytes} bytes`,
        ) as NodeJS.ErrnoException;
        error.code = 'EFBIG';
        throw error;
      }
      const buf = await handle.readFile();
      return { content: buf.toString('base64'), size: info.size };
    } finally {
      await handle.close();
    }
  } catch (error) {
    actionableNoFollowError(error, params.relPath);
  }
}

export async function fsHash(params: ConfinedPath): Promise<{ sha256: string; size: number }> {
  const { target } = resolveConfinedPath(params);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    const hash = createHash('sha256');
    await new Promise<void>((done, reject) => {
      const stream = handle.createReadStream({ autoClose: false });
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', done);
    });
    return { sha256: hash.digest('hex'), size: info.size };
  } finally {
    await handle.close();
  }
}

export async function fsStat(
  params: ConfinedPath,
): Promise<{ size: number; isFile: boolean; isDirectory: boolean }> {
  const { target } = resolveConfinedPath(params);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    return { size: info.size, isFile: info.isFile(), isDirectory: info.isDirectory() };
  } finally {
    await handle.close();
  }
}

export async function fsRealpath(params: ConfinedPath): Promise<{ path: string }> {
  const { target } = resolveConfinedPath(params);
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

export async function fsExists(params: ConfinedPath): Promise<{ exists: boolean }> {
  try {
    const { target } = resolveConfinedPath(params);
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
