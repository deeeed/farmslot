import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_TASK_DIR } from '@farmslot/protocol';

import { loadSlotVars, resolveProjectTaskDirName } from '../core/config.js';
import { execLocal, isLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import {
  invalidateArtifactTextCache,
  invalidateLiveRecipeContextMemo,
} from '../live-recipe/context.js';
import { getRun } from '../runs/store.js';

import { loadProjectVarsOrNull } from './project-vars.js';

export async function copyTaskFilesToSlot(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run?.slotId || !run.taskFile) return;

  try {
    const vars = await loadSlotVars(run.slotId);
    const pv = await loadProjectVarsOrNull(run.project, 'run recovery', run.id);
    const taskDirName = pv
      ? resolveProjectTaskDirName(pv.projectJson)
      : DEFAULT_TASK_DIR;

    const taskDir = path.dirname(run.taskFile);
    const taskFolderId = path.basename(taskDir);
    const flowSubdir = path.basename(path.dirname(taskDir));
    const workerTaskAbs = path.join(vars.remoteRepo, taskDirName, flowSubdir, taskFolderId);

    if (isLocal(vars.host, vars.machine)) {
      await mkdir(workerTaskAbs, { recursive: true });
      await copyFile(run.taskFile, path.join(workerTaskAbs, 'TASK.md'));
      for (const subdir of ['assets', 'inputs', 'artifacts']) {
        const localDir = path.join(taskDir, subdir);
        if (existsSync(localDir)) {
          // Forward task sync intentionally includes the full prepared artifact
          // tree; WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES only applies to
          // worker-to-gateway release copies where gateway-owned outputs must
          // not be overwritten.
          await cp(localDir, path.join(workerTaskAbs, subdir), { recursive: true });
        }
      }
      console.log(`[run-engine] copied task files to ${workerTaskAbs}`);
    } else {
      const sshTarget = vars.sshTarget;
      const mkdirRes = await execLocal(
        `ssh ${shellQuote(sshTarget)} ${shellQuote(`mkdir -p ${shellQuote(workerTaskAbs)}`)}`,
      );
      if (mkdirRes.exitCode !== 0) {
        throw new Error(
          `ssh mkdir ${workerTaskAbs} failed: ${mkdirRes.stderr.trim() || mkdirRes.stdout.trim() || `exit ${mkdirRes.exitCode}`}`,
        );
      }
      const scpRes = await execLocal(
        `scp -q ${shellQuote(run.taskFile)} ${shellQuote(`${sshTarget}:${workerTaskAbs}/TASK.md`)}`,
      );
      if (scpRes.exitCode !== 0) {
        throw new Error(
          `scp TASK.md to ${sshTarget}:${workerTaskAbs} failed: ${scpRes.stderr.trim() || scpRes.stdout.trim() || `exit ${scpRes.exitCode}`}`,
        );
      }
      for (const subdir of ['assets', 'inputs', 'artifacts']) {
        const localDir = path.join(taskDir, subdir);
        if (!existsSync(localDir)) continue;
        // Forward task sync intentionally includes the full prepared artifact
        // tree; WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES only applies to
        // worker-to-gateway release copies where gateway-owned outputs must
        // not be overwritten.
        const rsyncRes = await execLocal(
          `rsync -az ${shellQuote(`${localDir}/`)} ${shellQuote(`${sshTarget}:${workerTaskAbs}/${subdir}/`)}`,
        );
        if (rsyncRes.exitCode !== 0) {
          throw new Error(
            `rsync ${subdir}/ to ${sshTarget}:${workerTaskAbs} failed: ${rsyncRes.stderr.trim() || rsyncRes.stdout.trim() || `exit ${rsyncRes.exitCode}`}`,
          );
        }
      }
      console.log(`[run-engine] copied task files to ${sshTarget}:${workerTaskAbs}`);
    }
    // Same rationale as methods/dispatch.ts: we just wrote artifacts/ into the
    // worker task dir. Worker-prefix cache entries warmed before this copy must
    // be dropped so loadLiveRecipeContextForRun re-reads them.
    invalidateArtifactTextCache(path.join(workerTaskAbs, 'artifacts'), run.slotId);
    invalidateLiveRecipeContextMemo(run.id);
  } catch (err) {
    // Push failures must surface — workers depend on inputs/ and assets/ being
    // present, and silent loss leads to opaque downstream failures (missing
    // review-input artifacts, unresolved fixtures). The caller (startRun's
    // post-WRITE_TASK hook) propagates this as a step failure.
    throw new Error(`[run-engine] task file copy to slot failed: ${(err as Error).message}`);
  }
}
