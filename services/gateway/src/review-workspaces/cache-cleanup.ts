import { randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, readlink, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import type { Run } from '@farmslot/protocol';

import { execFileArgv } from '../core/exec.js';

import { reclaimReviewWorkspaceStorage, runNeedsExecutionStorage } from './storage-use.js';
import { REVIEW_WORKSPACE_SCRIPT } from './workspace-node.js';

interface CleanupStorage {
  runs: () => Promise<Run[]>;
  runsDir: string;
  nativeRoot: string;
}

const digestPattern = /^[a-f0-9]{64}$/;
const retiredPattern = /^\.reclaim-[a-f0-9]{64}-[a-f0-9-]{36}$/;

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

async function allocatorIsIdle(ownerRoot: string): Promise<boolean> {
  const operations = path.join(ownerRoot, 'operations');
  for (const name of await entries(path.join(ownerRoot, 'locks'))) {
    const file = path.join(ownerRoot, 'locks', name);
    if (!(await lstat(file)).isSymbolicLink()) return false;
    const target = path.resolve(path.dirname(file), await readlink(file));
    if (path.dirname(target) !== operations || !/^[a-f0-9-]{36}$/.test(path.basename(target)))
      return false;
    if ((await metadata(path.join(target, 'state.json')))?.state !== 'complete') return false;
  }
  // Cleanup receipts cover historical workspaces whose run record is no longer live.
  for (const name of await entries(path.join(ownerRoot, 'runs'))) {
    const workspace = path.join(ownerRoot, 'runs', name);
    if (
      !(await directory(workspace)) ||
      (await metadata(path.join(workspace, 'allocation.json')))?.state !== 'cleaned' ||
      (await directory(path.join(workspace, 'source')))
    )
      return false;
  }
  return true;
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
      if (!dryRun) {
        // Remove the published name atomically before deletion can be interrupted.
        const retired = path.join(
          path.dirname(target),
          `.reclaim-${path.basename(target)}-${randomUUID()}`,
        );
        await rename(target, retired);
        await rm(retired, { recursive: true });
      }
      removed.push(target);
      return true;
    };
    const reap = async (target: string) => {
      if (!retiredPattern.test(path.basename(target))) return false;
      if (!referenced(target) && (await directory(target))) {
        if (!dryRun) await rm(target, { recursive: true });
        removed.push(target);
      }
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
      const candidates: string[] = [];
      for (const name of await entries(root)) {
        if (await reap(path.join(root, name))) continue;
        if (!digestPattern.test(name) || protectedDigests.has(name)) continue;
        const target = path.join(root, name);
        if (referenced(target) || !(await directory(target))) continue;
        const manifest = await metadata(path.join(target, 'manifest.json'));
        if (manifest?.version !== 1 || manifest.sha256 !== name) continue;
        // Evict the lookup first: the next admission rebuilds instead of reading a stale index.
        if (gateway && !dryRun) for (const file of sources.get(name) ?? []) await rm(file);
        if (gateway) await remove(target);
        else candidates.push(name);
      }
      return candidates;
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
          !(await allocatorIsIdle(ownerRoot))
        )
          continue;
        const supportRoot = path.join(ownerRoot, 'support');
        const digests = await support(supportRoot, false);
        if (dryRun) removed.push(...digests.map((digest) => path.join(supportRoot, digest)));
        else if (digests.length) {
          // The node allocator owns the cross-process claim through receipt checks and rename.
          const result = await execFileArgv(
            [
              process.execPath,
              '-e',
              REVIEW_WORKSPACE_SCRIPT,
              JSON.stringify({ root: ownerRoot, action: 'reclaim-support', digests }),
            ],
            { timeout: 30_000 },
          );
          const receipt: unknown = JSON.parse(result.stdout);
          if (!record(receipt)) throw new Error('Invalid review cache retirement receipt');
          if (result.exitCode !== 0) {
            if (
              record(receipt.error) &&
              receipt.error.code === 'REVIEW_WORKSPACE_OPERATION_PENDING'
            )
              continue;
            throw new Error(result.stderr || 'Review cache retirement failed');
          }
          if (!Array.isArray(receipt.retired)) throw new Error('Missing cache retirement paths');
          for (const name of receipt.retired) {
            if (
              typeof name !== 'string' ||
              !retiredPattern.test(name) ||
              !digests.includes(name.slice(9, 73))
            )
              throw new Error('Invalid cache retirement path');
            await rm(path.join(supportRoot, name), { recursive: true });
            removed.push(path.join(supportRoot, name.slice(9, 73)));
          }
        }
        // Bare repositories retain the Git objects used by saved Code/Diff views.
      }
    }
    return removed.sort();
  });
}
