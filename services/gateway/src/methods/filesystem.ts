// methods/filesystem.ts — fs.list, fs.read, fs.write, fs.rename, fs.delete, fs.reveal, fs.mkdir, serveFile, serveRunArtifact

import { execFile as execFileCb, spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
import {
  type ArtifactRef,
  DEFAULT_TASK_DIR,
  type FileEntry,
  type FsDeleteParams,
  type FsListParams,
  type FsListResult,
  type FsMkdirParams,
  type FsReadParams,
  type FsReadResult,
  type FsRenameParams,
  type FsRevealParams,
  type FsWriteParams,
  type FsWriteResult,
  type OkResult,
  type Run,
} from '@farmslot/protocol';

import {
  getOrchestratorTaskRoot,
  loadProjectVars,
  loadSlotVars,
  resolveProjectTaskDirName,
  resolveTaskRelDir,
} from '../core/config.js';
import { farmslotRoot } from '../core/index.js';
import { normalizeRemotePath, resolvePathWithinRemoteBase } from '../core/remote-paths.js';
import { getNode } from '../fleet/machine-registry.js';
import { getSlotLocality, sendNodeRequest } from '../fleet/node-rpc.js';
import { loadPoolConfigs } from '../fleet/state.js';
import {
  attachLiveRecipeContext,
  invalidateArtifactTextCache,
  listRecipeRunArtifactGroupsForRun,
} from '../live-recipe/context.js';

import {
  mimeForPath,
  serveBufferWithRange,
  serveLocalFileWithRange,
} from './filesystem/range-serving.js';

const EXT_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.json': 'json',
  '.md': 'markdown',
  '.sh': 'shellscript',
  '.bash': 'shellscript',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.css': 'css',
  '.html': 'html',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.java': 'java',
  '.xml': 'xml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.env': 'dotenv',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.dockerfile': 'dockerfile',
  '.lock': 'plaintext',
  '.txt': 'plaintext',
};

const RECIPE_RUN_GROUP_CACHE_TTL_MS = 1_000;

function parseMaxRemoteRunArtifactBytes(): number {
  const raw = process.env.MAX_REMOTE_RUN_ARTIFACT_BYTES;
  const parsed = Number(raw ?? `${25 * 1024 * 1024}`);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid MAX_REMOTE_RUN_ARTIFACT_BYTES: ${raw ?? '<unset>'}`);
  }
  return parsed;
}

const MAX_REMOTE_RUN_ARTIFACT_BYTES = parseMaxRemoteRunArtifactBytes();
type CachedRecipeRunGroup = {
  id: string;
  groupKind: string;
  artifactRoot: string | null;
  artifactManifest: ArtifactRef[] | null;
};
type RecipeRunGroupCacheEntry =
  | { expiresAt: number; groups: CachedRecipeRunGroup[] }
  | { expiresAt: number; promise: Promise<CachedRecipeRunGroup[]> };

const recipeRunGroupCache = new Map<string, RecipeRunGroupCacheEntry>();

export function invalidateRecipeRunGroupCache(runId: string): void {
  recipeRunGroupCache.delete(runId);
}

function isPathWithinBase(targetPath: string, basePath: string): boolean {
  const relativePath = path.relative(path.resolve(basePath), path.resolve(targetPath));
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

// Best-effort fast-fail for obvious traversal. This is not the confinement
// guarantee: the acting open uses O_NOFOLLOW and the opened handle. Race-free
// whole-path containment requires openat2(RESOLVE_BENEATH/RESOLVE_IN_ROOT),
// which Node does not expose. The residual is dormant while fs.* is not
// operator-reachable and the in-slot agent already has equivalent OS access.
// For remote reads, collapsing stat/realpath/read into one bounded handle-based
// RPC also removes the gateway's former best-effort intermediate-symlink
// realpath check; lexical confinement and final-component O_NOFOLLOW remain,
// but intermediate-component symlinks are subject to this same openat2 gap.
// Remote pool configs can declare repos as `~/...`; path.resolve against those
// produces a gateway-local absolute path, so a startsWith(repoPath) check on
// the resolved target gives false negatives. Guard on the relative portion
// instead and let local/remote compose their own absolute target.
function assertRepoRelative(rel: string): void {
  if (!rel || rel === '') return;
  if (path.isAbsolute(rel)) throw new Error('Path traversal outside repo is not allowed');
  const normalized = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Path traversal outside repo is not allowed');
  }
  if (normalized.split('/').includes('.git')) {
    const error = new Error('Access to .git is not allowed') as NodeJS.ErrnoException;
    error.code = 'EACCES';
    throw error;
  }
}

function translateNoFollowError(error: unknown, relPath: string): never {
  if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
    const translated = new Error(
      `Refusing final-component symlink: ${relPath}`,
    ) as NodeJS.ErrnoException;
    translated.code = 'EACCES';
    throw translated;
  }
  throw error;
}

async function openLocalReadHandle(targetPath: string, relPath: string) {
  try {
    return await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    translateNoFollowError(error, relPath);
  }
}

function resolveLocalRepoTargetPath(repoPath: string, rel: string): string {
  const targetPath = path.resolve(repoPath, rel || '.');
  if (!isPathWithinBase(targetPath, repoPath)) {
    throw new Error('Path traversal outside repo is not allowed');
  }
  return targetPath;
}

async function assertLocalRepoTargetResolvesWithinRepo(
  targetPath: string,
  repoPath: string,
): Promise<void> {
  await assertResolvedPathWithinBase(targetPath, repoPath, realpath);
}

async function assertLocalMutationTargetResolvesWithinRepo(
  targetPath: string,
  repoPath: string,
): Promise<void> {
  let candidatePath = targetPath;
  while (true) {
    try {
      await assertResolvedPathWithinBase(candidatePath, repoPath, realpath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parentPath = path.dirname(candidatePath);
      if (parentPath === candidatePath) throw error;
      candidatePath = parentPath;
    }
  }
}

async function resolveRepoPath(slotId: string): Promise<string> {
  const pools = await loadPoolConfigs();
  for (const pool of pools) {
    const slot = pool.slots.find((s) => s.id === slotId);
    if (slot) {
      if (!slot.repo) throw new Error(`No repo path configured for slot ${slotId}`);
      const repo = slot.repo;
      if (repo === '.' || repo.startsWith('./') || repo.startsWith('../')) {
        const host = pool.host ?? 'localhost';
        if (host === 'localhost' || host === '127.0.0.1') {
          return path.resolve(farmslotRoot, repo);
        }
      }
      return repo;
    }
  }
  throw new Error(`Slot ${slotId} not found in pool configs`);
}

async function getCachedRecipeRunGroups(run: Run): Promise<CachedRecipeRunGroup[]> {
  const cached = recipeRunGroupCache.get(run.id);
  if (cached) {
    if ('groups' in cached && cached.expiresAt > Date.now()) {
      return cached.groups;
    }
    // In-flight requests are intentionally shared even if their TTL window would
    // have elapsed by the time another caller arrives; once the promise settles
    // we replace it with a fresh timestamped value (or delete on failure).
    if ('promise' in cached) {
      return cached.promise;
    }
    invalidateRecipeRunGroupCache(run.id);
  }

  const promise = (async () => {
    const groups = await listRecipeRunArtifactGroupsForRun(await attachLiveRecipeContext(run));
    const simplified = groups.map((group) => ({
      id: group.id,
      groupKind: group.groupKind,
      artifactRoot: group.artifactRoot,
      artifactManifest: group.artifactManifest,
    }));
    recipeRunGroupCache.set(run.id, {
      expiresAt: Date.now() + RECIPE_RUN_GROUP_CACHE_TTL_MS,
      groups: simplified,
    });
    return simplified;
  })().catch((error) => {
    // Delete before rethrowing so the next caller fetches a fresh value instead
    // of inheriting a stale rejected entry from the shared promise path.
    invalidateRecipeRunGroupCache(run.id);
    throw error;
  });

  recipeRunGroupCache.set(run.id, {
    expiresAt: Date.now() + RECIPE_RUN_GROUP_CACHE_TTL_MS,
    promise,
  });
  return promise;
}

async function resolveRemoteTaskArtifactsRoot(run: Run): Promise<string | null> {
  if (!run.slotId || !run.taskFile) return null;
  try {
    const slotVars = await loadSlotVars(run.slotId);
    const projectVars = await loadProjectVars(run.project).catch(() => null);
    const orchestratorTaskRoot = getOrchestratorTaskRoot(
      run.project,
      projectVars?.projectJson ?? null,
    );
    const taskRelDir =
      resolveTaskRelDir(run.taskFile, orchestratorTaskRoot) ??
      (run.taskFile.includes('/tasks/')
        ? (run.taskFile.split('/tasks/')[1]?.replace(/\/TASK\.md$/, '') ?? null)
        : null);
    if (taskRelDir === null) return null;
    const taskDirName = projectVars
      ? resolveProjectTaskDirName(projectVars.projectJson)
      : DEFAULT_TASK_DIR;
    return path.join(slotVars.remoteRepo, taskDirName, taskRelDir, 'artifacts');
  } catch {
    return null;
  }
}

async function resolveRemoteRecipeArtifactRoot(
  run: Run,
  selectedRecipeArtifactRoot: string | null,
): Promise<string | null> {
  const remoteTaskArtifactsRoot = await resolveRemoteTaskArtifactsRoot(run);
  if (!remoteTaskArtifactsRoot) return null;
  if (!selectedRecipeArtifactRoot) return remoteTaskArtifactsRoot;
  if (!run.taskFile) return selectedRecipeArtifactRoot;

  const localTaskArtifactsRoot = path.join(path.dirname(run.taskFile), 'artifacts');
  const relativeRecipeArtifactRoot = path.relative(
    localTaskArtifactsRoot,
    selectedRecipeArtifactRoot,
  );
  if (
    relativeRecipeArtifactRoot === '' ||
    (!relativeRecipeArtifactRoot.startsWith('..') && !path.isAbsolute(relativeRecipeArtifactRoot))
  ) {
    return path.join(remoteTaskArtifactsRoot, relativeRecipeArtifactRoot);
  }

  return selectedRecipeArtifactRoot;
}

export function shouldServeRecipeArtifactFromLocalCache(
  run: Run,
  selectedRecipeArtifactRoot: string | null,
  isLocal: boolean,
): boolean {
  if (!selectedRecipeArtifactRoot) return false;
  if (isLocal) return true;
  if (!run.taskFile) return false;
  const localTaskArtifactsRoot = path.join(path.dirname(run.taskFile), 'artifacts');
  return isPathWithinBase(selectedRecipeArtifactRoot, localTaskArtifactsRoot);
}

function isResolvedPathWithinBase(targetPath: string, basePath: string): boolean {
  const normalizedTargetPath = targetPath.replaceAll('\\', '/');
  const normalizedBasePath = basePath.replaceAll('\\', '/');
  return (
    normalizedTargetPath === normalizedBasePath ||
    normalizedTargetPath.startsWith(`${normalizedBasePath}/`)
  );
}

async function assertResolvedPathWithinBase(
  targetPath: string,
  basePath: string,
  resolvePath: (inputPath: string) => Promise<string>,
): Promise<void> {
  const [resolvedTargetPath, resolvedBasePath] = await Promise.all([
    resolvePath(targetPath),
    resolvePath(basePath),
  ]);
  if (!isResolvedPathWithinBase(resolvedTargetPath, resolvedBasePath)) {
    const error = new Error('Path traversal not allowed');
    (error as NodeJS.ErrnoException).code = 'EACCES';
    throw error;
  }
}

async function assertResolvedBasePathIsConcrete(
  basePath: string,
  resolvePath: (inputPath: string) => Promise<string>,
): Promise<void> {
  const [resolvedBasePath, resolvedParentPath] = await Promise.all([
    resolvePath(basePath),
    resolvePath(path.dirname(basePath)),
  ]);
  const expectedResolvedBasePath = path.join(resolvedParentPath, path.basename(basePath));
  if (!isResolvedPathWithinBase(resolvedBasePath, expectedResolvedBasePath)) {
    const error = new Error('Path traversal not allowed');
    (error as NodeJS.ErrnoException).code = 'EACCES';
    throw error;
  }
}

async function assertLocalSlot(slotId: string): Promise<void> {
  const { isLocal } = await getSlotLocality(slotId);
  if (!isLocal) {
    throw new Error(`Slot ${slotId} is remote — this operation only supports local slots`);
  }
}

function filterGitIgnored(repoPath: string, entries: string[]): Promise<Set<string>> {
  if (entries.length === 0) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const proc = spawn('git', ['check-ignore', '--stdin'], {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.on('close', () => {
      resolve(new Set(stdout.trim().split('\n').filter(Boolean)));
    });
    proc.on('error', () => {
      resolve(new Set());
    });
    proc.stdin.write(entries.join('\n'));
    proc.stdin.end();
  });
}

export async function fsList(params: FsListParams): Promise<FsListResult> {
  assertRepoRelative(params.path);
  const repoPath = await resolveRepoPath(params.slotId);
  const { isLocal, machine } = await getSlotLocality(params.slotId);

  if (!isLocal) {
    return fsListRemote(machine, repoPath, params);
  }

  const targetPath = resolveLocalRepoTargetPath(repoPath, params.path);
  await assertLocalRepoTargetResolvesWithinRepo(targetPath, repoPath);

  const dirEntries = await readdir(targetPath, { withFileTypes: true });
  const filtered = dirEntries.filter((e) => e.name !== '.git');

  const relativePaths = filtered.map((e) => {
    const fullPath = path.join(targetPath, e.name);
    return path.relative(repoPath, fullPath);
  });
  const ignoredSet = await filterGitIgnored(repoPath, relativePaths);

  const entries: FileEntry[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i];
    const relativePath = relativePaths[i];
    const isIgnored = ignoredSet.has(relativePath);
    if (isIgnored && !params.includeIgnored) continue;

    const fullPath = path.join(targetPath, entry.name);
    const entryRelPath = path.relative(repoPath, fullPath);

    if (entry.isDirectory()) {
      entries.push({
        name: entry.name,
        type: 'directory',
        path: entryRelPath,
        ...(isIgnored && { ignored: true }),
      });
    } else if (entry.isFile()) {
      try {
        const stats = await stat(fullPath);
        entries.push({
          name: entry.name,
          type: 'file',
          path: entryRelPath,
          size: stats.size,
          ...(isIgnored && { ignored: true }),
        });
      } catch {
        entries.push({
          name: entry.name,
          type: 'file',
          path: entryRelPath,
          ...(isIgnored && { ignored: true }),
        });
      }
    } else if (entry.isSymbolicLink()) {
      try {
        const stats = await stat(fullPath);
        if (stats.isDirectory()) {
          entries.push({
            name: entry.name,
            type: 'directory',
            path: entryRelPath,
            ...(isIgnored && { ignored: true }),
          });
        } else if (stats.isFile()) {
          entries.push({
            name: entry.name,
            type: 'file',
            path: entryRelPath,
            size: stats.size,
            ...(isIgnored && { ignored: true }),
          });
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

async function fsListRemote(
  machine: string,
  repoPath: string,
  params: FsListParams,
): Promise<FsListResult> {
  // Use native node fs.list — fast, no shell overhead
  const node = getNode(machine);
  if (!node) throw new Error(`No node connected for machine ${machine}`);
  const result = (await sendNodeRequest(node, 'fs.list', {
    root: repoPath,
    relPath: params.path,
  })) as {
    entries: Array<{ name: string; type: string; size?: number }>;
  };

  // Check gitignored entries. Use a structured node RPC rather than a
  // shell-interpolated command so filenames containing quotes, spaces, `$`,
  // or backticks cannot inject into the remote shell.
  let ignoredSet = new Set<string>();
  if (result.entries.length > 0) {
    const relDir = params.path === '.' ? '' : params.path + '/';
    const names = result.entries.map((e) => relDir + e.name);
    try {
      const ignoreResult = (await sendNodeRequest(node, 'fs.checkIgnore', { repoPath, names })) as {
        ignored: string[];
      };
      ignoredSet = new Set(ignoreResult.ignored);
    } catch {
      /* git not available or error — show all */
    }
  }

  const entries: FileEntry[] = [];
  for (const e of result.entries) {
    const relDir = params.path === '.' ? '' : params.path + '/';
    const entryRelPath = relDir + e.name;
    const isIgnored = ignoredSet.has(entryRelPath);
    if (isIgnored && !params.includeIgnored) continue;
    entries.push({
      name: e.name,
      type: e.type as 'file' | 'directory',
      path: entryRelPath,
      size: e.size,
      ...(isIgnored && { ignored: true }),
    });
  }

  return { entries };
}

export async function fsRead(params: FsReadParams): Promise<FsReadResult> {
  assertRepoRelative(params.path);
  const repoPath = await resolveRepoPath(params.slotId);
  const { isLocal, machine } = await getSlotLocality(params.slotId);

  let content: string;
  if (isLocal) {
    const targetPath = resolveLocalRepoTargetPath(repoPath, params.path);
    await assertLocalRepoTargetResolvesWithinRepo(targetPath, repoPath);
    const handle = await openLocalReadHandle(targetPath, params.path);
    try {
      content = await handle.readFile('utf-8');
    } finally {
      await handle.close();
    }
  } else {
    // Use node's fs.read
    const node = getNode(machine);
    if (!node) throw new Error(`No node connected for machine ${machine}`);
    const result = (await sendNodeRequest(node, 'fs.read', {
      root: repoPath,
      relPath: params.path,
    })) as { content: string };
    content = result.content;
  }

  const ext = path.extname(params.path).toLowerCase();
  const base = path.basename(params.path).toLowerCase();

  let language = EXT_LANGUAGE[ext] || 'plaintext';
  if (base === 'dockerfile') language = 'dockerfile';
  else if (base === 'makefile') language = 'makefile';
  else if (base === '.gitignore' || base === '.gitattributes') language = 'gitignore';

  return { content, language };
}

export async function fsWrite(params: FsWriteParams): Promise<FsWriteResult> {
  assertRepoRelative(params.path);
  const repoPath = await resolveRepoPath(params.slotId);
  const { isLocal, machine } = await getSlotLocality(params.slotId);
  if (isLocal) {
    const targetPath = resolveLocalRepoTargetPath(repoPath, params.path);
    await assertLocalMutationTargetResolvesWithinRepo(targetPath, repoPath);
    let handle;
    try {
      handle = await open(
        targetPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o666,
      );
      await handle.writeFile(params.content, 'utf-8');
    } catch (error) {
      translateNoFollowError(error, params.path);
    } finally {
      await handle?.close();
    }
  } else {
    const node = getNode(machine);
    if (!node) throw new Error(`No node connected for machine ${machine}`);
    await sendNodeRequest(node, 'fs.write', {
      root: repoPath,
      relPath: params.path,
      content: params.content,
    });
  }
  // Drop the cached entry for the written file's directory so the next read
  // round-trip returns the freshly-written content instead of the previous
  // value held by the 5s artifact-text cache. Path-scoped to the file's
  // dirname (round-5 L2: `undefined` over-broadly cleared the slot's whole
  // cache) AND slot-scoped so two slots sharing a path don't interfere.
  const writtenAbs = isLocal
    ? resolveLocalRepoTargetPath(repoPath, params.path)
    : `${repoPath}/${params.path}`;
  invalidateArtifactTextCache(path.dirname(writtenAbs), params.slotId);
  return { ok: true };
}

export async function fsRename(params: FsRenameParams): Promise<OkResult> {
  assertRepoRelative(params.oldPath);
  assertRepoRelative(params.newPath);
  const repoPath = await resolveRepoPath(params.slotId);
  const { isLocal, machine } = await getSlotLocality(params.slotId);
  if (isLocal) {
    const oldTargetPath = resolveLocalRepoTargetPath(repoPath, params.oldPath);
    const newTargetPath = resolveLocalRepoTargetPath(repoPath, params.newPath);
    await assertLocalRepoTargetResolvesWithinRepo(oldTargetPath, repoPath);
    await assertLocalMutationTargetResolvesWithinRepo(newTargetPath, repoPath);
    await rename(oldTargetPath, newTargetPath);
    return { ok: true };
  }

  const node = getNode(machine);
  if (!node) throw new Error(`No node connected for machine ${machine}`);
  await sendNodeRequest(node, 'fs.rename', {
    root: repoPath,
    oldRelPath: params.oldPath,
    newRelPath: params.newPath,
  });
  return { ok: true };
}

export async function fsDelete(params: FsDeleteParams): Promise<OkResult> {
  assertRepoRelative(params.path);
  const repoPath = await resolveRepoPath(params.slotId);
  const { isLocal, machine } = await getSlotLocality(params.slotId);
  if (isLocal) {
    const targetPath = resolveLocalRepoTargetPath(repoPath, params.path);
    await assertLocalMutationTargetResolvesWithinRepo(targetPath, repoPath);
    await rm(targetPath, { recursive: true });
    return { ok: true };
  }

  const node = getNode(machine);
  if (!node) throw new Error(`No node connected for machine ${machine}`);
  await sendNodeRequest(node, 'fs.delete', { root: repoPath, relPath: params.path });
  return { ok: true };
}

export async function fsReveal(params: FsRevealParams): Promise<OkResult> {
  assertRepoRelative(params.path);
  await assertLocalSlot(params.slotId);
  const repoPath = await resolveRepoPath(params.slotId);
  const targetPath = resolveLocalRepoTargetPath(repoPath, params.path);
  await assertLocalRepoTargetResolvesWithinRepo(targetPath, repoPath);

  // macOS: open -R reveals in Finder
  await execFile('open', ['-R', targetPath]);
  return { ok: true };
}

export async function fsMkdir(params: FsMkdirParams): Promise<OkResult> {
  assertRepoRelative(params.path);
  const repoPath = await resolveRepoPath(params.slotId);
  const { isLocal, machine } = await getSlotLocality(params.slotId);
  if (isLocal) {
    const targetPath = resolveLocalRepoTargetPath(repoPath, params.path);
    await assertLocalMutationTargetResolvesWithinRepo(targetPath, repoPath);
    await mkdir(targetPath, { recursive: true });
    return { ok: true };
  }

  const node = getNode(machine);
  if (!node) throw new Error(`No node connected for machine ${machine}`);
  await sendNodeRequest(node, 'fs.mkdir', { root: repoPath, relPath: params.path });
  return { ok: true };
}

// --- HTTP file serving (for images and binary files) ---

export async function serveFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const slotId = url.searchParams.get('slotId');
    const filePath = url.searchParams.get('path');

    if (!slotId || !filePath) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing slotId or path');
      return;
    }

    try {
      assertRepoRelative(filePath);
    } catch {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Path traversal not allowed');
      return;
    }

    const repoPath = await resolveRepoPath(slotId);
    const { isLocal, machine } = await getSlotLocality(slotId);
    const mime = mimeForPath(filePath);

    if (isLocal) {
      const targetPath = resolveLocalRepoTargetPath(repoPath, filePath);
      await assertLocalRepoTargetResolvesWithinRepo(targetPath, repoPath);
      const handle = await openLocalReadHandle(targetPath, filePath);
      const stats = await handle.stat();
      serveLocalFileWithRange(req, res, handle, mime, stats.size);
    } else {
      // Remote: progress-aware chunked read (small files still one-shot inside helper).
      // Preserve repo root confinement — never collapse node RPC root to `/`.
      const { slotReadFileBuffer } = await import('../core/slot-io.js');
      const vars = await (await import('../core/config.js')).loadSlotVars(slotId);
      const remoteRoot = repoPath.replace(/\\/g, '/').replace(/\/+$/, '');
      const remoteRel = filePath.replace(/^\/+/, '');
      const remoteAbs = path.posix.join(remoteRoot, remoteRel);
      let transferMode = 'unknown';
      let readChunkCount = 0;
      const buf = await slotReadFileBuffer(
        { host: vars.host, machine: vars.machine, sshTarget: vars.sshTarget },
        remoteAbs,
        {
          root: remoteRoot,
          relPath: remoteRel,
          label: path.basename(filePath),
          phase: 'download',
          slotId,
          maxBytes: MAX_REMOTE_RUN_ARTIFACT_BYTES,
          onTransport: (info) => {
            transferMode = info.mode;
            readChunkCount = info.readChunkCount;
          },
        },
      );
      serveBufferWithRange(req, res, buf, mime, {
        'X-Farmslot-Transfer-Mode': transferMode,
        'X-Farmslot-Read-Chunk-Count': String(readChunkCount),
      });
    }
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    const message = error.message || String(err);
    if (error.code === 'EACCES') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Path traversal not allowed');
      return;
    }
    if (message.includes('too large to proxy')) {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end(message);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(message);
  }
}

// Serve a file relative to a run's task artifact directory.
// URL: /api/run-artifact?runId=X&path=Y[&recipeRunId=Z]  (path is relative to task dir or selected recipe-run artifact root)
export async function serveRunArtifact(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const runId = url.searchParams.get('runId');
    const filePath = url.searchParams.get('path');
    const recipeRunId = url.searchParams.get('recipeRunId');

    if (!runId || !filePath) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing runId or path');
      return;
    }

    const { getRun } = await import('../runs/store.js');
    const run = getRun(runId);
    if (!run?.taskFile) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Run not found or no taskFile');
      return;
    }

    if (recipeRunId && !filePath.startsWith('artifacts/')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Recipe run artifact paths must start with artifacts/');
      return;
    }

    const relativePath = recipeRunId ? filePath.slice('artifacts/'.length) : filePath;
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes('..')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Path traversal not allowed');
      return;
    }

    const taskDir = path.dirname(run.taskFile);
    let selectedRecipeArtifactRoot: string | null = null;
    let basePath = taskDir;
    if (recipeRunId) {
      const groups = await getCachedRecipeRunGroups(run);
      const selected = groups.find((group) => group.id === recipeRunId);
      if (!selected?.artifactRoot) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Recipe run artifact root not found');
        return;
      }
      selectedRecipeArtifactRoot = selected.artifactRoot;
      basePath = selected.artifactRoot;
    }

    const normalizedBasePath = path.resolve(basePath);
    const targetPath = path.resolve(normalizedBasePath, relativePath);
    if (
      !(
        targetPath === normalizedBasePath ||
        targetPath.startsWith(`${normalizedBasePath}${path.sep}`)
      )
    ) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Path traversal not allowed');
      return;
    }

    const mime = mimeForPath(targetPath);

    const serveArtifactFromBase = async (
      basePathToServe: string,
      artifactRelativePath = relativePath,
      assertConcreteRoot = Boolean(recipeRunId),
    ) => {
      const normalizedServeBasePath = path.resolve(basePathToServe);
      const targetPathToServe = path.resolve(normalizedServeBasePath, artifactRelativePath);
      if (assertConcreteRoot) {
        await assertResolvedBasePathIsConcrete(normalizedServeBasePath, realpath);
      }
      await assertResolvedPathWithinBase(targetPathToServe, normalizedServeBasePath, realpath);
      const handle = await openLocalReadHandle(targetPathToServe, artifactRelativePath);
      const stats = await handle.stat();
      serveLocalFileWithRange(req, res, handle, mime, stats.size);
    };

    if (!recipeRunId) {
      // UI sends `vsize=<bytes>` (preferred) or legacy `v=s<size>` derived
      // from the live artifact manifest. When the worker rewrites an artifact
      // after the orchestrator rsync (baseline-rerun, recipe re-screenshot),
      // the orchestrator mirror keeps the old bytes but the manifest's
      // size/sha matches the fresh slot copy. Detect the mismatch via vsize
      // and route to the slot so reviewers see the bytes the worker captured.
      //
      // Empty / non-numeric `vsize` falls through to legacy `v=s<size>` so a
      // malformed primary hint doesn't suppress an otherwise-valid one.
      // 0-byte artifacts are intentionally excluded from stale-detect: there
      // is no legitimate 0-byte capture, and treating size 0 as "expected"
      // would route every empty file to slot fallback on every read.
      const vsizeParam = url.searchParams.get('vsize');
      const legacyV = url.searchParams.get('v');
      const parsedVsize = vsizeParam !== null ? Number(vsizeParam) : NaN;
      const parsedLegacy = legacyV?.startsWith('s') ? Number(legacyV.slice(1)) : NaN;
      const expectedSize = Number.isFinite(parsedVsize)
        ? parsedVsize
        : Number.isFinite(parsedLegacy)
          ? parsedLegacy
          : null;
      const serveFromRecipeRunPackageFallback = async (): Promise<boolean> => {
        const recipeRelativePath = relativePath.startsWith('artifacts/')
          ? relativePath.slice('artifacts/'.length)
          : relativePath;
        const groups = await getCachedRecipeRunGroups(run);
        for (const group of groups) {
          if (group.groupKind === 'current-artifacts' || !group.artifactRoot) continue;
          const manifestEntry = group.artifactManifest?.find((entry) => entry.path === filePath);
          if (
            typeof expectedSize === 'number' &&
            expectedSize > 0 &&
            typeof manifestEntry?.sizeBytes === 'number' &&
            manifestEntry.sizeBytes !== expectedSize
          ) {
            continue;
          }
          try {
            await serveArtifactFromBase(group.artifactRoot, recipeRelativePath, true);
            return true;
          } catch (candidateErr) {
            const candidateError = candidateErr as NodeJS.ErrnoException;
            if (candidateError.code === 'ENOENT') continue;
            throw candidateErr;
          }
        }
        return false;
      };
      const serveFromSlotFallback = async () => {
        if (!run.slotId) throw new Error('Run not attached to a slot');
        const slotArtifactsRoot = await resolveRemoteTaskArtifactsRoot(run);
        if (!slotArtifactsRoot) throw new Error('Slot artifacts root unresolved');
        // resolveRemoteTaskArtifactsRoot already includes the trailing
        // `artifacts/` segment, while relativePath in this branch begins with
        // `artifacts/` (the orchestrator-side basePath was the taskDir, not
        // its artifacts/ subdir). Strip the redundant prefix before joining.
        const slotRelativePath = relativePath.startsWith('artifacts/')
          ? relativePath.slice('artifacts/'.length)
          : relativePath;
        const { isLocal, machine } = await getSlotLocality(run.slotId);
        if (isLocal) {
          const slotTarget = path.resolve(slotArtifactsRoot, slotRelativePath);
          // Realpath check must run BEFORE stat/read — the worker controls the
          // artifacts dir and could plant a symlink pointing outside the slot
          // root. Mirrors the orchestrator-side serveArtifactFromBase guard.
          await assertResolvedPathWithinBase(slotTarget, slotArtifactsRoot, realpath);
          const handle = await openLocalReadHandle(slotTarget, slotRelativePath);
          const stats = await handle.stat();
          serveLocalFileWithRange(req, res, handle, mime, stats.size);
          return;
        }
        const node = getNode(machine);
        if (!node) throw new Error(`No node connected for machine ${machine}`);
        const normalizedRemoteBasePath = normalizeRemotePath(slotArtifactsRoot);
        const remoteTargetPath = resolvePathWithinRemoteBase(
          normalizedRemoteBasePath,
          slotRelativePath,
        );
        if (!remoteTargetPath) throw new Error('Path traversal not allowed');
        const { slotReadFileBuffer } = await import('../core/slot-io.js');
        const vars = await (await import('../core/config.js')).loadSlotVars(run.slotId!);
        const remoteRoot = normalizedRemoteBasePath.replace(/\\/g, '/').replace(/\/+$/, '');
        const remoteRel = slotRelativePath.replace(/^\/+/, '');
        const remoteAbs = path.posix.join(remoteRoot, remoteRel);
        let transferMode = 'unknown';
        let readChunkCount = 0;
        const buffer = await slotReadFileBuffer(
          { host: vars.host, machine: vars.machine, sshTarget: vars.sshTarget },
          remoteAbs,
          {
            root: remoteRoot,
            relPath: remoteRel,
            label: path.basename(slotRelativePath),
            phase: 'download',
            runId,
            slotId: run.slotId ?? undefined,
            maxBytes: MAX_REMOTE_RUN_ARTIFACT_BYTES,
            onTransport: (info) => {
              transferMode = info.mode;
              readChunkCount = info.readChunkCount;
            },
          },
        );
        serveBufferWithRange(req, res, buffer, mime, {
          'X-Farmslot-Transfer-Mode': transferMode,
          'X-Farmslot-Read-Chunk-Count': String(readChunkCount),
        });
      };

      if (Number.isFinite(expectedSize) && (expectedSize as number) > 0 && run.slotId) {
        try {
          const orchestratorStats = await stat(targetPath);
          if (orchestratorStats.size !== expectedSize) {
            if (await serveFromRecipeRunPackageFallback()) {
              return;
            }
            try {
              await serveFromSlotFallback();
              return;
            } catch (slotErr) {
              // Slot unreachable or missing — fall through to the
              // orchestrator copy so reviewers see *something* rather than
              // a 404. Logged so operators can correlate stale renders with
              // unreachable slots.
              console.warn(
                `[filesystem] stale-mirror fallback to slot failed for runId=${runId} path=${filePath}: ${(slotErr as Error).message}`,
              );
            }
          }
        } catch (statErr) {
          // ENOENT here means the mirror file is missing entirely; the
          // serveArtifactFromBase call below will fall into its own ENOENT
          // -> slot fallback. Anything else is a real fs error worth
          // surfacing alongside the eventual response.
          if ((statErr as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn(
              `[filesystem] stale-detect stat failed for runId=${runId} path=${filePath}: ${(statErr as Error).message}`,
            );
          }
        }
      }

      try {
        await serveArtifactFromBase(basePath);
        return;
      } catch (err) {
        // Orchestrator-side mirror is rsynced once at run completion. Files
        // the worker writes post-completion (baseline-rerun screenshots,
        // refreshed evidence-manifest.json) live only on the slot until the
        // next mirror sync. Fall back to the slot's own task-artifacts dir
        // so reviewers can scrub evidence from the slot view before the
        // post-run mirror catches up.
        const error = err as NodeJS.ErrnoException;
        if (error.code !== 'ENOENT') throw err;
        if (await serveFromRecipeRunPackageFallback()) {
          return;
        }
        if (!run.slotId) throw err;
        await serveFromSlotFallback();
        return;
      }
    }

    if (!run.slotId) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Run not attached to a slot');
      return;
    }

    const { isLocal, machine } = await getSlotLocality(run.slotId);

    if (
      shouldServeRecipeArtifactFromLocalCache(run, selectedRecipeArtifactRoot, isLocal) &&
      selectedRecipeArtifactRoot &&
      existsSync(selectedRecipeArtifactRoot)
    ) {
      try {
        await serveArtifactFromBase(selectedRecipeArtifactRoot);
        return;
      } catch (error) {
        const localError = error as NodeJS.ErrnoException;
        if (isLocal || localError.code !== 'ENOENT') throw error;
      }
    }

    if (isLocal) {
      await serveArtifactFromBase(basePath);
      return;
    }

    const node = getNode(machine);
    if (!node) throw new Error(`No node connected for machine ${machine}`);
    const remoteBasePath =
      (await resolveRemoteRecipeArtifactRoot(run, selectedRecipeArtifactRoot)) ??
      normalizedBasePath;
    const normalizedRemoteBasePath = normalizeRemotePath(remoteBasePath);
    const remoteTargetPath = resolvePathWithinRemoteBase(normalizedRemoteBasePath, relativePath);
    if (!remoteTargetPath) {
      const error = new Error('Path traversal not allowed');
      (error as NodeJS.ErrnoException).code = 'EACCES';
      throw error;
    }
    const { slotReadFileBuffer } = await import('../core/slot-io.js');
    const vars = await (await import('../core/config.js')).loadSlotVars(run.slotId);
    const remoteRoot = normalizedRemoteBasePath.replace(/\\/g, '/').replace(/\/+$/, '');
    const remoteRel = relativePath.replace(/^\/+/, '');
    const remoteAbs = path.posix.join(remoteRoot, remoteRel);
    let transferMode = 'unknown';
    let readChunkCount = 0;
    const buffer = await slotReadFileBuffer(
      { host: vars.host, machine: vars.machine, sshTarget: vars.sshTarget },
      remoteAbs,
      {
        root: remoteRoot,
        relPath: remoteRel,
        label: path.basename(relativePath),
        phase: 'download',
        runId,
        slotId: run.slotId,
        maxBytes: MAX_REMOTE_RUN_ARTIFACT_BYTES,
        onTransport: (info) => {
          transferMode = info.mode;
          readChunkCount = info.readChunkCount;
        },
      },
    );
    serveBufferWithRange(req, res, buffer, mime, {
      'X-Farmslot-Transfer-Mode': transferMode,
      'X-Farmslot-Read-Chunk-Count': String(readChunkCount),
    });
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    const message = error.message || String(err);
    console.warn('[filesystem] serveRunArtifact failed', err);
    if (error.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(message);
      return;
    }
    if (error.code === 'EACCES') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(message);
      return;
    }
    if (message.includes('too large to proxy')) {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end(message);
      return;
    }
    if (
      message.includes('No node connected') ||
      message.includes('ECONN') ||
      message.includes('socket')
    ) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(message);
      return;
    }
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(message);
  }
}
