import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import type { Run } from '@farmslot/protocol';

import { reclaimReviewWorkspaceStorage, runNeedsExecutionStorage } from './storage-use.js';

interface CleanupStorage {
  runs: () => Promise<Run[]>;
  runsDir: string;
  nativeRoot: string;
}

const digestPattern = /^[a-f0-9]{64}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function directory(file: string): Promise<boolean> {
  try {
    const entry = await lstat(file);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function entries(file: string): Promise<string[]> {
  return (await directory(file)) ? readdir(file) : [];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function metadata(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink()) return undefined;
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    return record(value) ? value : undefined;
  } catch (error) {
    // Incomplete or foreign metadata cannot authorize deleting its payload.
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT')
      return undefined;
    throw error;
  }
}

function absolutePaths(value: unknown, paths: Set<string>): void {
  if (typeof value === 'string') {
    if (path.isAbsolute(value)) paths.add(path.resolve(value));
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) absolutePaths(child, paths);
  }
}

/** Remove execution caches only. Task views, reports, archives and retained bundles are separate. */
export function cleanupReviewWorkspaceCaches(
  dryRun: boolean,
  storage: CleanupStorage,
): Promise<string[]> {
  return reclaimReviewWorkspaceStorage(async () => {
    const runs = await storage.runs();
    const byId = new Map(runs.map((run) => [run.id, run]));
    const protectedDigests = new Set<string>();
    const protectedOwners = new Set<string>();
    const retainedPaths = new Set<string>();
    for (const run of runs) {
      // The support binding describes an execution cache, not a retained report artifact.
      const { reviewWorkspace, ...record } = run;
      absolutePaths(record, retainedPaths);
      if (reviewWorkspace) absolutePaths({ ...reviewWorkspace, support: undefined }, retainedPaths);
      if (runNeedsExecutionStorage(run)) {
        if (reviewWorkspace?.support) protectedDigests.add(reviewWorkspace.support.sha256);
        if (reviewWorkspace)
          protectedOwners.add(path.resolve(reviewWorkspace.checkoutPath, '../../..'));
      }
    }
    const referenced = (directory: string) =>
      [...retainedPaths].some(
        (file) => file === directory || file.startsWith(directory + path.sep),
      );
    const cacheRoot = path.join(storage.runsDir, 'review-workspace-support');
    if (!(await directory(storage.runsDir))) return [];
    if (await directory(cacheRoot)) {
      // Interrupted admission can precede publication of reviewWorkspace.support.
      for (const name of await entries(path.join(cacheRoot, 'admissions'))) {
        if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) continue;
        const admission = await metadata(path.join(cacheRoot, 'admissions', name));
        const run = byId.get(name.slice(0, -5));
        if (typeof admission?.digest === 'string' && (!run || runNeedsExecutionStorage(run)))
          protectedDigests.add(admission.digest);
      }
    }
    const removed: string[] = [];
    const remove = async (target: string) => {
      if (referenced(target) || !(await directory(target))) return false;
      if (!dryRun) await rm(target, { recursive: true });
      removed.push(target);
      return true;
    };
    const sources = new Map<string, string[]>();
    for (const name of await entries(path.join(cacheRoot, 'sources-v2'))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = path.join(cacheRoot, 'sources-v2', name);
      const index = await metadata(file);
      if (typeof index?.digest === 'string')
        sources.set(index.digest, [...(sources.get(index.digest) ?? []), file]);
    }
    const support = async (root: string, gateway: boolean) => {
      for (const name of await entries(root)) {
        if (!digestPattern.test(name) || protectedDigests.has(name)) continue;
        const target = path.join(root, name);
        if (referenced(target) || !(await directory(target))) continue;
        const manifest = await metadata(path.join(target, 'manifest.json'));
        if (manifest?.version !== 1 || manifest.sha256 !== name) continue;
        // Evict the lookup first: the next admission rebuilds instead of reading a stale index.
        if (gateway && !dryRun) for (const file of sources.get(name) ?? []) await rm(file);
        await remove(target);
      }
    };
    if (await directory(cacheRoot)) await support(path.join(cacheRoot, 'bundles'), true);

    // Current local layout and the historical node layout are both gateway-managed roots.
    for (const root of new Set([
      path.join(path.dirname(storage.nativeRoot), 'review-workspaces'),
      path.join(storage.nativeRoot, 'nodes', 'review-workspaces'),
    ])) {
      for (const ownerHash of await entries(root)) {
        if (!digestPattern.test(ownerHash)) continue;
        const ownerRoot = path.join(root, ownerHash);
        if (
          !(await directory(ownerRoot)) ||
          protectedOwners.has(ownerRoot) ||
          (await entries(path.join(ownerRoot, 'locks'))).length
        )
          continue;
        await support(path.join(ownerRoot, 'support'), false);
        const repositories = path.join(ownerRoot, 'repositories');
        for (const name of await entries(repositories)) {
          if (!digestPattern.test(name)) continue;
          const target = path.join(repositories, name);
          const marker = path.join(repositories, name + '.json');
          const identity = await metadata(marker);
          if (
            !identity ||
            typeof identity.owner !== 'string' ||
            typeof identity.project !== 'string' ||
            typeof identity.repositoryUrl !== 'string' ||
            hash(identity.owner) !== ownerHash ||
            hash(
              JSON.stringify({
                owner: identity.owner,
                project: identity.project,
                repositoryUrl: identity.repositoryUrl,
              }),
            ) !== name ||
            (await entries(path.join(target, 'worktrees'))).length
          )
            continue;
          if (await remove(target)) {
            if (!dryRun) await rm(marker);
          }
        }
      }
    }
    return removed.sort();
  });
}
