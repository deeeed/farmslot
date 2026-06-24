import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_TASK_DIR, isInternalRunArtifactPath, type Run } from '@farmslot/protocol';

import { removeStaleArtifactDirectory } from '../core/artifact-cleanup.js';
import {
  isGatewayOwnedArtifactMirrorEntry,
  WORKER_ARTIFACT_COPY_EXCLUDES,
  WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES,
} from '../core/artifact-copy-policy.js';
import {
  getOrchestratorTaskRoot,
  getProjectField,
  loadProjectVars,
  loadSlotVars,
  resolveTaskRelDir,
} from '../core/config.js';
import {
  type LatestValidRecipeRunPointer,
  sanitizeLatestValidRecipeRunPointer,
} from '../core/index.js';
import {
  slotCopyDir,
  slotCopyFile,
  slotFileExists,
  slotListDir,
  slotReadFile,
  slotWriteFiles,
} from '../core/slot-io.js';
import {
  invalidateArtifactTextCache,
  invalidateLiveRecipeContextMemo,
} from '../live-recipe/context.js';

import { type EvidenceManifest, evidenceManifestArtifactPaths } from './evidence-manifest.js';
import { readEvidenceManifest } from './publication-artifacts.js';

// Push ONLY the executable recipe workflows (recipe.json + recipe-flows/) from
// the gateway-owned mirror to a slot's worker task dir, so a run loaded onto
// the slot (slot-side run loader / activate) can be replayed there. Evidence
// (screenshots/videos) is intentionally NOT synced — only what execution needs,
// so this stays lightweight (a handful of small JSON files). The slot-io layer
// handles local and remote nodes transparently. Best-effort by nature: a run
// with no mirrored recipe simply has nothing to push (existsSync guards), so
// the recipe-replay gate then accurately reports it as unavailable; real IO
// failures propagate to the caller rather than being swallowed.
export async function pushRunRecipeToSlot(
  run: Run,
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
): Promise<number> {
  if (!run.taskFile) return 0;
  const pv = await loadProjectVars(run.project).catch(() => null);
  const taskRelDir = resolveTaskRelDir(
    run.taskFile,
    getOrchestratorTaskRoot(run.project, pv?.projectJson ?? null),
  );
  if (taskRelDir === null) return 0;
  const taskDirName = pv
    ? getProjectField(pv.projectJson, 'task_dir') || DEFAULT_TASK_DIR
    : DEFAULT_TASK_DIR;
  const localArtifactsDir = path.join(path.dirname(run.taskFile), 'artifacts');
  const workerArtifactsDir = path.join(vars.remoteRepo, taskDirName, taskRelDir, 'artifacts');

  // One batch write (base64) — slotWriteFiles creates parent dirs, so it works
  // even when the slot has never run this task (no temp/tasks/.../artifacts/ yet).
  const files: Array<{ path: string; content: string }> = [];
  const localRecipe = path.join(localArtifactsDir, 'recipe.json');
  if (existsSync(localRecipe)) {
    files.push({ path: 'recipe.json', content: (await readFile(localRecipe)).toString('base64') });
  }
  const localFlowsDir = path.join(localArtifactsDir, 'recipe-flows');
  if (existsSync(localFlowsDir)) {
    for (const name of await readdir(localFlowsDir)) {
      const full = path.join(localFlowsDir, name);
      if (!(await lstat(full)).isFile()) continue;
      files.push({
        path: path.join('recipe-flows', name),
        content: (await readFile(full)).toString('base64'),
      });
    }
  }
  if (files.length === 0) return 0;
  await slotWriteFiles(vars, workerArtifactsDir, files);
  console.log(
    `[run-completion] synced recipe workflows (${files.length} file(s)) to ${vars.slotId} for run ${run.id.slice(0, 8)}`,
  );
  return files.length;
}

export function shouldClearLocalRecipeRunCache(
  workerPointerExists: boolean,
  promotedPointer: LatestValidRecipeRunPointer | null,
): boolean {
  return !workerPointerExists && !promotedPointer;
}

// ─── Artifact copy ───

async function clearWorkerOwnedArtifactMirror(
  localArtifactsDir: string,
  options: { preserveRecipeRuns: boolean },
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(localArtifactsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  await Promise.all(
    entries
      .filter((name) => {
        if (options.preserveRecipeRuns && name === 'recipe-runs') return false;
        return !isGatewayOwnedArtifactMirrorEntry(name);
      })
      .map((name) => rm(path.join(localArtifactsDir, name), { recursive: true, force: true })),
  );
}

async function workerGatewayOwnedCopyExcludes(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  workerArtifactsDir: string,
): Promise<string[]> {
  if (!(await slotFileExists(vars, workerArtifactsDir))) return [];
  return (await slotListDir(vars, workerArtifactsDir)).filter(isGatewayOwnedArtifactMirrorEntry);
}

async function copyEvidenceManifestReferencedArtifacts(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  workerArtifactsDir: string,
  localArtifactsDir: string,
  manifest: EvidenceManifest | null | undefined,
): Promise<number> {
  const manifestPaths = evidenceManifestArtifactPaths(manifest);
  let copied = 0;
  for (const artifactPath of manifestPaths) {
    if (isInternalRunArtifactPath(artifactPath)) {
      throw new Error(`evidence-manifest references internal artifact: ${artifactPath}`);
    }
    const relativePath = artifactPath.slice('artifacts/'.length);
    const workerPath = path.join(workerArtifactsDir, relativePath);
    if (!(await slotFileExists(vars, workerPath))) {
      throw new Error(`evidence-manifest references missing artifact: ${artifactPath}`);
    }
    const localPath = path.join(localArtifactsDir, relativePath);
    await mkdir(path.dirname(localPath), { recursive: true });
    await slotCopyFile(vars, workerPath, localPath);
    copied += 1;
  }
  return copied;
}

// Sync slot-side artifacts -> orchestrator mirror. Throws on copy failure so
// explicit user-triggered callers (run.refreshMirror) can surface the error.
// Best-effort callers must wrap in their own try/catch (see complete()).
export async function refreshArtifactMirror(run: Run): Promise<number> {
  if (!run.slotId || !run.taskFile) return 0;

  const vars = await loadSlotVars(run.slotId);
  const taskDir = path.dirname(run.taskFile);
  const pv = await loadProjectVars(run.project).catch(() => null);
  const taskRelDir = resolveTaskRelDir(
    run.taskFile,
    getOrchestratorTaskRoot(run.project, pv?.projectJson ?? null),
  );
  if (taskRelDir === null) return 0;

  const taskDirName = pv
    ? getProjectField(pv.projectJson, 'task_dir') || DEFAULT_TASK_DIR
    : DEFAULT_TASK_DIR;
  const workerTaskDir = path.join(vars.remoteRepo, taskDirName, taskRelDir);
  const workerArtifactsDir = path.join(workerTaskDir, 'artifacts');
  const localArtifactsDir = path.join(taskDir, 'artifacts');
  const workerPointerPath = path.join(workerArtifactsDir, 'latest-valid-recipe-run.json');
  const workerPointerExists = await slotFileExists(vars, workerPointerPath);
  let promotedPointer: LatestValidRecipeRunPointer | null = null;
  if (workerPointerExists) {
    try {
      promotedPointer = sanitizeLatestValidRecipeRunPointer(
        JSON.parse(await slotReadFile(vars, workerPointerPath)) as LatestValidRecipeRunPointer,
      );
      if (!promotedPointer) {
        console.warn(
          `[run-completion] preserving local recipe-runs cache because promoted pointer is invalid at ${workerPointerPath}`,
        );
      }
    } catch (error) {
      promotedPointer = null;
      console.warn(
        `[run-completion] preserving local recipe-runs cache because promoted pointer could not be parsed at ${workerPointerPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Copy top-level artifacts first, but skip bulk recipe-runs history on the hot path.
  // slotCopyDir failures intentionally reject this refresh; a partially copied
  // artifact mirror is not trustworthy.
  const clearLocalRecipeRuns = shouldClearLocalRecipeRunCache(workerPointerExists, promotedPointer);
  await clearWorkerOwnedArtifactMirror(localArtifactsDir, {
    preserveRecipeRuns: !clearLocalRecipeRuns,
  });
  const gatewayOwnedWorkerEntries = await workerGatewayOwnedCopyExcludes(vars, workerArtifactsDir);
  let copied = await slotCopyDir(vars, workerArtifactsDir, localArtifactsDir, {
    excludeTopLevel: [...WORKER_ARTIFACT_COPY_EXCLUDES, ...gatewayOwnedWorkerEntries],
    excludeRelativePaths: [...WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES],
  });
  // Defensive cleanup for stale local mirrors created before screenshots/ was excluded.
  await removeStaleArtifactDirectory(path.join(localArtifactsDir, 'screenshots'));
  copied += await copyEvidenceManifestReferencedArtifacts(
    vars,
    workerArtifactsDir,
    localArtifactsDir,
    await readEvidenceManifest(run),
  );
  if (promotedPointer) {
    const promotedLocalRoot = path.join(localArtifactsDir, promotedPointer.relativeArtifactRoot);
    // Promoted snapshot copy failures also reject so callers never publish a
    // mixed current/promoted evidence view.
    copied += await slotCopyDir(
      vars,
      path.join(workerArtifactsDir, promotedPointer.relativeArtifactRoot),
      promotedLocalRoot,
      { excludeTopLevel: ['screenshots'] },
    );
    // Defensive cleanup for stale promoted mirrors created before screenshots/ was excluded.
    await removeStaleArtifactDirectory(path.join(promotedLocalRoot, 'screenshots'));
  } else if (clearLocalRecipeRuns) {
    await removeStaleArtifactDirectory(path.join(localArtifactsDir, 'recipe-runs'));
  }
  if (copied > 0) {
    console.log(`[run-completion] copied ${copied} artifact(s) from worker`);
  }

  // Assumption: recipe-runs are only pruned after the promoted snapshot is copied,
  // and readers should tolerate a brief overlap while stale entries are removed.
  await pruneRecipeRunHistory(localArtifactsDir);

  // Drop the live-recipe-context caches whether or not we copied — pruneRecipeRunHistory
  // can delete recipe-runs/<id>/summary.json + recipe.json even when copy was a no-op
  // (e.g. promoted pointer changed but underlying files matched). Cached entries for
  // those just-deleted files would otherwise serve "alive" status for up to 5s.
  // Clear BOTH the local prefix (orchestrator-side reads) AND the worker prefix
  // (loadLiveRecipeContextForRun tries the worker artifact root first via
  // shouldPreferLocalPortableArtifacts), scoped to this run's slotId so we don't
  // disturb other slots' cache entries.
  invalidateArtifactTextCache(localArtifactsDir, run.slotId);
  invalidateArtifactTextCache(workerArtifactsDir, run.slotId);
  invalidateLiveRecipeContextMemo(run.id);

  // Copy TASK.md back (worker may have updated checkboxes)
  const workerTask = path.join(workerTaskDir, 'TASK.md');
  if (await slotFileExists(vars, workerTask)) {
    await slotCopyFile(vars, workerTask, path.join(taskDir, 'TASK.md.worker'));
  }
  return copied;
}

export async function pruneRecipeRunHistory(localArtifactsDir: string): Promise<void> {
  const pointerPath = path.join(localArtifactsDir, 'latest-valid-recipe-run.json');
  if (!existsSync(pointerPath)) return;

  let pointer: LatestValidRecipeRunPointer | null = null;
  try {
    pointer = sanitizeLatestValidRecipeRunPointer(
      JSON.parse(await readFile(pointerPath, 'utf-8')) as LatestValidRecipeRunPointer,
    );
  } catch (error) {
    console.warn(
      `[run-completion] failed to read latest valid recipe-run pointer at ${pointerPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (!pointer) {
    console.warn(`[run-completion] invalid latest valid recipe-run pointer at ${pointerPath}`);
    return;
  }

  const keepRunId = pointer.runId;
  const recipeRunsDir = path.join(localArtifactsDir, 'recipe-runs');
  if (!existsSync(recipeRunsDir)) return;
  const keepRunPath = path.join(recipeRunsDir, keepRunId);
  const keepRunStats = await lstat(keepRunPath).catch(() => null);
  if (!keepRunStats || !keepRunStats.isDirectory()) {
    console.warn(
      `[run-completion] skipping recipe run history prune because promoted run cache is missing at ${keepRunPath}`,
    );
    return;
  }

  const entries = await readdir(recipeRunsDir).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry !== keepRunId)
      .map(async (entry) => {
        const entryPath = path.join(recipeRunsDir, entry);
        const stats = await lstat(entryPath).catch(() => null);
        if (!stats) return;
        if (stats.isSymbolicLink()) {
          console.warn(`[run-completion] skipping symlinked recipe run history entry ${entryPath}`);
          return;
        }
        await rm(entryPath, { recursive: true, force: true }).catch((error) => {
          console.warn(
            `[run-completion] failed to prune recipe run history entry ${entryPath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }),
  );
}
