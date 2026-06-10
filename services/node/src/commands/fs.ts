import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream, existsSync, type FSWatcher, watch } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

// Pool configs can declare remote repos as `~/...`. The gateway composes
// absolute-looking paths but `~` is a shell token, not a filesystem prefix —
// node:fs treats it literally. Expand to $HOME before any disk op.
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}/${p.slice(2)}`;
  return p;
}

export interface FsEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

export async function fsList(params: { path: string }): Promise<{ entries: FsEntry[] }> {
  const root = expandTilde(params.path);
  const dirEntries = await readdir(root, { withFileTypes: true });
  const entries: FsEntry[] = [];
  for (const entry of dirEntries) {
    if (entry.name === '.git' || entry.name === '.' || entry.name === '..') continue;
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, type: 'directory' });
    } else if (entry.isFile()) {
      try {
        const s = await stat(`${root}/${entry.name}`);
        entries.push({ name: entry.name, type: 'file', size: s.size });
      } catch {
        entries.push({ name: entry.name, type: 'file' });
      }
    }
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { entries };
}

export async function fsRead(params: { path: string }): Promise<{ content: string }> {
  const content = await readFile(expandTilde(params.path), 'utf-8');
  return { content };
}

export async function fsWrite(params: { path: string; content: string }): Promise<{ ok: true }> {
  await writeFile(expandTilde(params.path), params.content, 'utf-8');
  return { ok: true };
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
  baseDir: string;
  files: FsWriteFileEntry[];
}): Promise<{ ok: true; count: number }> {
  const base = resolve(expandTilde(params.baseDir));
  for (const file of params.files) {
    const dest = resolve(join(base, file.path));
    if (dest !== base && !dest.startsWith(base + sep)) {
      throw new Error(`fs.writeFiles refuses path escaping baseDir: ${file.path}`);
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(file.content, 'base64'));
    if (typeof file.mode === 'number') await chmod(dest, file.mode);
  }
  return { ok: true, count: params.files.length };
}

export async function fsRename(params: {
  oldPath: string;
  newPath: string;
}): Promise<{ ok: true }> {
  await rename(expandTilde(params.oldPath), expandTilde(params.newPath));
  return { ok: true };
}

export async function fsDelete(params: { path: string }): Promise<{ ok: true }> {
  await rm(expandTilde(params.path), { recursive: true });
  return { ok: true };
}

export async function fsMkdir(params: { path: string }): Promise<{ ok: true }> {
  await mkdir(expandTilde(params.path), { recursive: true });
  return { ok: true };
}

export async function fsReadBase64(params: {
  path: string;
}): Promise<{ content: string; size: number }> {
  const buf = await readFile(expandTilde(params.path));
  return { content: buf.toString('base64'), size: buf.length };
}

export async function fsHash(params: { path: string }): Promise<{ sha256: string; size: number }> {
  const filePath = expandTilde(params.path);
  const info = await stat(filePath);
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { sha256: hash.digest('hex'), size: info.size };
}

export async function fsStat(params: {
  path: string;
}): Promise<{ size: number; isFile: boolean; isDirectory: boolean }> {
  const info = await stat(expandTilde(params.path));
  return { size: info.size, isFile: info.isFile(), isDirectory: info.isDirectory() };
}

export async function fsRealpath(params: { path: string }): Promise<{ path: string }> {
  return { path: await realpath(expandTilde(params.path)) };
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

export async function fsExists(params: { path: string }): Promise<{ exists: boolean }> {
  try {
    await access(expandTilde(params.path), constants.F_OK);
    return { exists: true };
  } catch {
    return { exists: false };
  }
}

// Track active watchers by request ID
const activeWatchers = new Map<string, FSWatcher>();

export function fsWatchStart(
  requestId: string,
  params: { path: string },
  onChange: (content: string) => void,
): void {
  // Clean up existing watcher for this ID if any
  fsWatchStop(requestId);

  const targetPath = expandTilde(params.path);

  if (existsSync(targetPath)) {
    // File exists — watch it directly
    const watcher = watch(targetPath, { persistent: false }, async () => {
      try {
        const content = await readFile(targetPath, 'utf-8');
        onChange(content);
      } catch {
        /* file may be mid-write */
      }
    });
    activeWatchers.set(requestId, watcher);
  } else {
    // File doesn't exist yet — watch parent directory for its creation
    const dir = dirname(targetPath);
    if (!existsSync(dir)) {
      console.log(`[fs.watch] parent dir doesn't exist: ${dir} — skipping watch`);
      return;
    }
    const target = basename(targetPath);
    const watcher = watch(dir, { persistent: false }, async (_, filename) => {
      if (filename !== target) return;
      if (!existsSync(targetPath)) return;
      // File appeared — read and notify
      try {
        const content = await readFile(targetPath, 'utf-8');
        onChange(content);
      } catch {
        /* file may be mid-write */
      }
      // Switch to watching the file directly for subsequent changes
      watcher.close();
      fsWatchStart(requestId, params, onChange);
    });
    activeWatchers.set(requestId, watcher);
  }
}

export function fsWatchStop(requestId: string): boolean {
  const watcher = activeWatchers.get(requestId);
  if (watcher) {
    watcher.close();
    activeWatchers.delete(requestId);
    return true;
  }
  return false;
}

export function fsWatchStopAll(): void {
  for (const watcher of activeWatchers.values()) {
    watcher.close();
  }
  activeWatchers.clear();
}
