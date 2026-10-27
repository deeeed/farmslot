// methods/filesystem.ts — fs.list, fs.read, fs.write, fs.rename, fs.delete, fs.reveal, fs.mkdir, serveFile, serveRunArtifact
import { execFile as execFileCb, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

import { serveRemoteRange } from './filesystem/remote-range-serving.js';

const execFile = promisify(execFileCb);
import {
  type ArtifactRef,
  type FileEntry,
  type FsConflictDetails,
  type FsDeleteParams,
  FsErrorCodes,
  type FsListParams,
  type FsListResult,
  type FsMkdirParams,
  type FsReadParams,
  type FsReadResult,
  type FsRenameParams,
  type FsRenameResult,
  type FsRevealParams,
  type FsWriteParams,
  type FsWriteResult,
  type OkResult,
  type Run,
  type RunArtifactBundleRef,
} from '@farmslot/protocol';

import { farmslotRoot } from '../core/index.js';
import { GatewayMethodError } from '../core/method-error.js';
import { type ConnectedNode, getNode } from '../fleet/machine-registry.js';
import { getSlotLocality, sendNodeRequest } from '../fleet/node-rpc.js';
import { loadPoolConfigs } from '../fleet/state.js';
import { invalidateArtifactTextCache } from '../live-recipe/context.js';

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
  recipeRunId: string | null;
  promoted: boolean;
  artifactRoot: string | null;
  artifactManifest: ArtifactRef[] | null;
};
type RecipeRunGroupCacheEntry =
  | { expiresAt: number; groups: CachedRecipeRunGroup[] }
  | { expiresAt: number; promise: Promise<CachedRecipeRunGroup[]> };

const recipeRunGroupCache = new Map<string, RecipeRunGroupCacheEntry>();

export function invalidateRecipeRunGroupCache(runId: string): void {
  for (const key of recipeRunGroupCache.keys()) {
    if (key.startsWith(`${runId}:`)) recipeRunGroupCache.delete(key);
  }
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

async function getCachedRecipeRunGroups(
  run: Run,
  ref: RunArtifactBundleRef,
): Promise<CachedRecipeRunGroup[]> {
  const key = `${run.id}:${ref.bundleDigest}`;
  const cached = recipeRunGroupCache.get(key);
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
    const { retainedRecipeRunGroups } = await import('../run-completion/retained-artifacts.js');
    const groups = await retainedRecipeRunGroups(run, ref);
    const simplified = groups.map((group) => ({
      id: group.id,
      groupKind: group.groupKind,
      recipeRunId: group.recipeRunId,
      promoted: group.promoted === true,
      artifactRoot: group.artifactRoot,
      artifactManifest: group.artifactManifest,
    }));
    recipeRunGroupCache.set(key, {
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

  recipeRunGroupCache.set(key, {
    expiresAt: Date.now() + RECIPE_RUN_GROUP_CACHE_TTL_MS,
    promise,
  });
  return promise;
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

async function assertLocalSlot(slotId: string): Promise<void> {
  const { isLocal } = await getSlotLocality(slotId);
  if (!isLocal) {
    throw new Error(`Slot ${slotId} is remote — this operation only supports local slots`);
  }
}

// ─── Conditional edits (ADR-009 Amendment 1) ───

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const CONFLICT_MESSAGES: Record<FsConflictDetails['reason'], string> = {
  hash: 'The file changed since it was read',
  run: 'The slot no longer serves the run this change was made for',
  'destination-exists': 'The rename destination already exists',
};

/** `hash: null` means nothing exists at the path, so the details carry no hash. */
function fsConflict(
  reason: FsConflictDetails['reason'],
  current: { hash?: string | null; runId?: string | null },
): GatewayMethodError {
  const details: FsConflictDetails = {
    reason,
    ...(current.hash ? { currentHash: current.hash } : {}),
    ...(current.runId !== undefined ? { currentRunId: current.runId } : {}),
  };
  return new GatewayMethodError(FsErrorCodes.conflict, CONFLICT_MESSAGES[reason], { details });
}

function assertConditionalParams(
  params: { expectedHash?: unknown; runId?: unknown },
  absentAllowed: boolean,
): void {
  const { expectedHash, runId } = params;
  if (
    expectedHash !== undefined &&
    typeof expectedHash !== 'string' &&
    !(absentAllowed && expectedHash === null)
  )
    throw new GatewayMethodError(
      'INVALID_PARAMS',
      absentAllowed ? 'expectedHash must be a string or null' : 'expectedHash must be a string',
    );
  if (runId !== undefined && runId !== null && typeof runId !== 'string')
    throw new GatewayMethodError('INVALID_PARAMS', 'runId must be a string or null');
}

/** The status row is the slot claim itself; read it fresh, not from the fleet snapshot. */
async function assertSlotRun(slotId: string, runId: string | null | undefined): Promise<void> {
  if (runId === undefined) return;
  const { readSlotRow } = await import('../core/state.js');
  const claimed = (await readSlotRow(slotId))?.current_run_id;
  const currentRunId = typeof claimed === 'string' && claimed ? claimed : null;
  if (currentRunId !== runId) throw fsConflict('run', { runId: currentRunId });
}

/** SHA-256 of a file's raw bytes, or null when nothing exists at the path. */
async function localFileHash(targetPath: string, relPath: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile())
      throw new Error(`File versions apply to files only: ${relPath}`);
    return sha256(await handle.readFile());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return translateNoFollowError(error, relPath);
  } finally {
    await handle?.close();
  }
}

async function assertLocalHash(
  targetPath: string,
  relPath: string,
  expectedHash: string,
): Promise<void> {
  const currentHash = await localFileHash(targetPath, relPath);
  if (currentHash !== expectedHash) throw fsConflict('hash', { hash: currentHash });
}

async function assertLocalDestinationAbsent(targetPath: string, relPath: string): Promise<void> {
  try {
    await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw fsConflict('destination-exists', { hash: await localFileHash(targetPath, relPath) });
}

/** Only a node that advertised conditional writes may receive a hashed write. */
function fileNode(machine: string, expectedHash: string | null | undefined): ConnectedNode {
  const node = getNode(machine);
  if (!node) throw new Error(`No node connected for machine ${machine}`);
  if (expectedHash !== undefined && !node.conditionalWrites)
    throw new GatewayMethodError(
      FsErrorCodes.preconditionUnsupported,
      `Node ${machine} cannot check file versions until it is updated`,
    );
  return node;
}

/** A node refusal keeps its details, so a remote conflict names the current state. */
async function nodeFileRequest(
  node: ConnectedNode,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await sendNodeRequest(node, method, params);
  } catch (error) {
    const refused = error as NodeJS.ErrnoException & { details?: unknown };
    if (refused.code === FsErrorCodes.conflict)
      throw new GatewayMethodError(refused.code, refused.message, { details: refused.details });
    throw error;
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
  let hash: string | undefined;
  if (isLocal) {
    const targetPath = resolveLocalRepoTargetPath(repoPath, params.path);
    await assertLocalRepoTargetResolvesWithinRepo(targetPath, repoPath);
    const handle = await openLocalReadHandle(targetPath, params.path);
    try {
      // Hash the raw bytes before decoding, as the node's fs.hash does.
      const bytes = await handle.readFile();
      content = bytes.toString('utf-8');
      hash = sha256(bytes);
    } finally {
      await handle.close();
    }
  } else {
    // Use node's fs.read. Nodes with conditional writes also return the hash.
    const node = getNode(machine);
    if (!node) throw new Error(`No node connected for machine ${machine}`);
    const result = (await sendNodeRequest(node, 'fs.read', {
      root: repoPath,
      relPath: params.path,
    })) as { content: string; hash?: unknown };
    content = result.content;
    if (typeof result.hash === 'string') hash = result.hash;
  }

  const ext = path.extname(params.path).toLowerCase();
  const base = path.basename(params.path).toLowerCase();

  let language = EXT_LANGUAGE[ext] || 'plaintext';
  if (base === 'dockerfile') language = 'dockerfile';
  else if (base === 'makefile') language = 'makefile';
  else if (base === '.gitignore' || base === '.gitattributes') language = 'gitignore';

  return { content, language, ...(hash ? { hash } : {}) };
}

export async function fsWrite(params: FsWriteParams): Promise<FsWriteResult> {
  assertRepoRelative(params.path);
  assertConditionalParams(params, true);
  const repoPath = await resolveRepoPath(params.slotId);
  const { isLocal, machine } = await getSlotLocality(params.slotId);
  await assertSlotRun(params.slotId, params.runId);
  let hash: string | undefined;
  if (isLocal) {
    const targetPath = resolveLocalRepoTargetPath(repoPath, params.path);
    await assertLocalMutationTargetResolvesWithinRepo(targetPath, repoPath);
    // Best effort: a hashed write checks, then writes. Creating uses O_EXCL.
    if (typeof params.expectedHash === 'string')
      await assertLocalHash(targetPath, params.path, params.expectedHash);
    let handle;
    try {
      handle = await open(
        targetPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          (params.expectedHash === null ? constants.O_EXCL : constants.O_TRUNC),
        0o666,
      );
      await handle.writeFile(params.content, 'utf-8');
    } catch (error) {
      if (params.expectedHash === null && (error as NodeJS.ErrnoException).code === 'EEXIST')
        throw fsConflict('hash', { hash: await localFileHash(targetPath, params.path) });
      translateNoFollowError(error, params.path);
    } finally {
      await handle?.close();
    }
    // A write without a precondition replies as before; a conditional one returns the new hash.
    if (params.expectedHash !== undefined) hash = sha256(params.content);
  } else {
    const result = (await nodeFileRequest(fileNode(machine, params.expectedHash), 'fs.write', {
      root: repoPath,
      relPath: params.path,
      content: params.content,
      ...(params.expectedHash !== undefined ? { expectedHash: params.expectedHash } : {}),
    })) as { hash?: unknown } | undefined;
    if (typeof result?.hash === 'string') hash = result.hash;
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
  return { ok: true, ...(hash ? { hash } : {}) };
}

export async function fsRename(params: FsRenameParams): Promise<FsRenameResult> {
  assertRepoRelative(params.oldPath);
  assertRepoRelative(params.newPath);
  assertConditionalParams(params, false);
  const repoPath = await resolveRepoPath(params.slotId);
  const { isLocal, machine } = await getSlotLocality(params.slotId);
  await assertSlotRun(params.slotId, params.runId);
  if (isLocal) {
    const oldTargetPath = resolveLocalRepoTargetPath(repoPath, params.oldPath);
    const newTargetPath = resolveLocalRepoTargetPath(repoPath, params.newPath);
    await assertLocalRepoTargetResolvesWithinRepo(oldTargetPath, repoPath);
    await assertLocalMutationTargetResolvesWithinRepo(newTargetPath, repoPath);
    if (typeof params.expectedHash === 'string') {
      await assertLocalHash(oldTargetPath, params.oldPath, params.expectedHash);
      await assertLocalDestinationAbsent(newTargetPath, params.newPath);
    }
    await rename(oldTargetPath, newTargetPath);
    // A rename keeps the bytes, so the checked hash is the new one.
    return { ok: true, ...(params.expectedHash ? { hash: params.expectedHash } : {}) };
  }

  const result = (await nodeFileRequest(fileNode(machine, params.expectedHash), 'fs.rename', {
    root: repoPath,
    oldRelPath: params.oldPath,
    newRelPath: params.newPath,
    ...(params.expectedHash !== undefined ? { expectedHash: params.expectedHash } : {}),
  })) as { hash?: unknown } | undefined;
  return { ok: true, ...(typeof result?.hash === 'string' ? { hash: result.hash } : {}) };
}

export async function fsDelete(params: FsDeleteParams): Promise<OkResult> {
  assertRepoRelative(params.path);
  assertConditionalParams(params, false);
  const repoPath = await resolveRepoPath(params.slotId);
  const { isLocal, machine } = await getSlotLocality(params.slotId);
  await assertSlotRun(params.slotId, params.runId);
  if (isLocal) {
    const targetPath = resolveLocalRepoTargetPath(repoPath, params.path);
    await assertLocalMutationTargetResolvesWithinRepo(targetPath, repoPath);
    if (typeof params.expectedHash === 'string') {
      // The hash check refuses directories: a hashed delete applies to files only.
      await assertLocalHash(targetPath, params.path, params.expectedHash);
      await rm(targetPath);
    } else await rm(targetPath, { recursive: true });
    return { ok: true };
  }

  await nodeFileRequest(fileNode(machine, params.expectedHash), 'fs.delete', {
    root: repoPath,
    relPath: params.path,
    ...(params.expectedHash !== undefined ? { expectedHash: params.expectedHash } : {}),
  });
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
  assertConditionalParams({ runId: params.runId }, false);
  const repoPath = await resolveRepoPath(params.slotId);
  const { isLocal, machine } = await getSlotLocality(params.slotId);
  await assertSlotRun(params.slotId, params.runId);
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
    const { isLocal } = await getSlotLocality(slotId);
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
      if (
        await serveRemoteRange(
          req,
          res,
          { machine: vars.machine, root: remoteRoot, relPath: remoteRel },
          mime,
          MAX_REMOTE_RUN_ARTIFACT_BYTES,
        )
      )
        return;
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
    const requested = url.searchParams.get('path');
    if (!runId || !requested) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing runId or path');
      return;
    }
    if (
      path.isAbsolute(requested) ||
      requested.split(/[\\/]/u).some((part) => part === '..' || part === '.')
    ) {
      throw Object.assign(new Error('Path traversal not allowed'), { code: 'EACCES' });
    }
    const { getRun } = await import('../runs/store.js');
    const run = getRun(runId);
    if (!run) throw new Error('Run not found.');
    const {
      retainedRunBundleRef,
      retainedRunTaskDirectory,
      runBundleStore,
      selectedRetainedRecipeGroup,
    } = await import('../run-completion/retained-artifacts.js');
    const { resolveRunBundleEntry } = await import('@farmslot/run-bundle');
    const recipeRunId = url.searchParams.get('recipeRunId');
    const decisionId =
      url.searchParams.get('decisionId') ??
      (recipeRunId === 'decision-evidence'
        ? run.decisions
            .slice()
            .reverse()
            .find((decision) => decision.payload?.kind === 'ready' && decision.payload.prPackage)
            ?.id
        : undefined);
    const ref = retainedRunBundleRef(
      run,
      decisionId,
      url.searchParams.get('bundleDigest') ?? undefined,
    );
    let artifactPath = requested;
    if (
      (recipeRunId && !['current-artifacts', 'decision-evidence'].includes(recipeRunId)) ||
      (!recipeRunId && requested !== run.output?.reportPath && requested.startsWith('artifacts/'))
    ) {
      if (!requested.startsWith('artifacts/'))
        throw new Error('Recipe artifact paths must start with artifacts/.');
      const groups = await getCachedRecipeRunGroups(run, ref);
      const group = recipeRunId
        ? groups.find((group) => group.id === recipeRunId)
        : selectedRetainedRecipeGroup(groups);
      if (recipeRunId && !group?.artifactRoot)
        throw new Error('Retained recipe execution is unavailable.');
      if (
        group?.artifactRoot &&
        (recipeRunId || group.artifactManifest?.some(({ path }) => path === requested))
      )
        artifactPath = path.posix.join(
          path
            .relative(await retainedRunTaskDirectory(run, ref), group.artifactRoot)
            .replaceAll('\\', '/'),
          requested.slice('artifacts/'.length),
        );
    }
    const entry = await resolveRunBundleEntry({
      store: await runBundleStore(),
      ref,
      runId,
      path: artifactPath,
    });
    const expected = url.searchParams.get('v');
    if (
      expected &&
      !expected.startsWith('s') &&
      !entry.sha256.startsWith(expected.replace(/^sha256:/u, ''))
    )
      throw new Error('This artifact link refers to a different retained snapshot.');
    res.setHeader('X-Farmslot-Bundle-Digest', ref.bundleDigest);
    res.setHeader('ETag', `"${entry.sha256}"`);
    const handle = await openLocalReadHandle(entry.path, artifactPath);
    try {
      // The client can disconnect while the retained entry and open are awaited.
      if (res.destroyed) {
        await handle.close();
        return;
      }
      // The shared range helper owns the handle after a successful stream handoff.
      serveLocalFileWithRange(req, res, handle, mimeForPath(entry.path), entry.bytes);
    } catch (error) {
      await handle.close();
      throw error;
    }
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(
      error instanceof Error && 'code' in error && error.code === 'EACCES' ? 403 : 404,
      { 'Content-Type': 'text/plain' },
    );
    res.end(message);
  }
}
