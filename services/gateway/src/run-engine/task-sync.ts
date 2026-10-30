import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { HANDOFF_INPUT, readTaskProvenance } from '@farmslot/agent-runtime';
import { DEFAULT_TASK_DIR, type TemplateProvenance } from '@farmslot/protocol';

import { loadSlotVars, resolveProjectTaskDirName } from '../core/config.js';
import { execLocal, isLocal } from '../core/exec.js';
import { RSYNC_SSH_SHELL_OPTION, SSH_CONNECT_SHELL_OPTIONS } from '../core/ssh-options.js';
import { shellQuote } from '../core/tmux.js';
import { auditBlindTrialTask } from '../evals/blind-trial.js';
import {
  invalidateArtifactTextCache,
  invalidateLiveRecipeContextMemo,
} from '../live-recipe/context.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';
import { initializeExistingTaskRuntime } from '../tasks/existing-runtime.js';
import { copyPreparedTaskRootSidecars } from '../tasks/sidecars.js';
import { initializeWrittenTask, TASK_INIT_INPUT } from '../tasks/writer.js';

import { loadProjectVarsOrNull } from './project-vars.js';

export async function copyTaskFilesToSlot(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run?.slotId || !run.taskFile) return;

  try {
    const vars = await loadSlotVars(run.slotId);
    const pv = await loadProjectVarsOrNull(run.project, 'run recovery', run.id);
    const taskDirName = pv ? resolveProjectTaskDirName(pv.projectJson) : DEFAULT_TASK_DIR;

    const taskDir = path.dirname(run.taskFile);
    await auditBlindTrialTask(run, taskDir);
    const taskFolderId = path.basename(taskDir);
    const flowSubdir = path.basename(path.dirname(taskDir));
    const workerTaskAbs = path.join(vars.remoteRepo, taskDirName, flowSubdir, taskFolderId);

    if (isLocal(vars.host, vars.machine)) {
      await mkdir(workerTaskAbs, { recursive: true });
      await copyFile(run.taskFile, path.join(workerTaskAbs, 'TASK.md'));
      await copyPreparedTaskRootSidecars({
        taskDir,
        workerTaskAbs,
        host: vars.host,
        machine: vars.machine,
        sshTarget: vars.sshTarget,
      });
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
        `ssh ${SSH_CONNECT_SHELL_OPTIONS} ${shellQuote(sshTarget)} ${shellQuote(`mkdir -p ${shellQuote(workerTaskAbs)}`)}`,
      );
      if (mkdirRes.exitCode !== 0) {
        throw new Error(
          `ssh mkdir ${workerTaskAbs} failed: ${mkdirRes.stderr.trim() || mkdirRes.stdout.trim() || `exit ${mkdirRes.exitCode}`}`,
        );
      }
      const scpRes = await execLocal(
        `scp -q ${SSH_CONNECT_SHELL_OPTIONS} ${shellQuote(run.taskFile)} ${shellQuote(`${sshTarget}:${workerTaskAbs}/TASK.md`)}`,
      );
      if (scpRes.exitCode !== 0) {
        throw new Error(
          `scp TASK.md to ${sshTarget}:${workerTaskAbs} failed: ${scpRes.stderr.trim() || scpRes.stdout.trim() || `exit ${scpRes.exitCode}`}`,
        );
      }
      await copyPreparedTaskRootSidecars({
        taskDir,
        workerTaskAbs,
        host: vars.host,
        machine: vars.machine,
        sshTarget,
      });
      for (const subdir of ['assets', 'inputs', 'artifacts']) {
        const localDir = path.join(taskDir, subdir);
        if (!existsSync(localDir)) continue;
        // Forward task sync intentionally includes the full prepared artifact
        // tree; WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES only applies to
        // worker-to-gateway release copies where gateway-owned outputs must
        // not be overwritten.
        const rsyncRes = await execLocal(
          `rsync -az ${RSYNC_SSH_SHELL_OPTION} ${shellQuote(`${localDir}/`)} ${shellQuote(`${sshTarget}:${workerTaskAbs}/${subdir}/`)}`,
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
    // review-input artifacts, unresolved fixtures). The caller (task
    // initialization in PREPARE or DISPATCH) propagates this as a step failure.
    throw new Error(`[run-engine] task file copy to slot failed: ${(err as Error).message}`);
  }
}

async function readTemplateProvenanceForTask(
  taskFilePath: string,
): Promise<TemplateProvenance | null> {
  const taskDir = path.dirname(taskFilePath);
  const provenance = readTaskProvenance(taskDir);
  if (!provenance?.templateProvenance) return null;
  const parsed = {
    ...provenance.templateProvenance,
    ...(provenance.executionTemplate ? { executionTemplate: provenance.executionTemplate } : {}),
  } as TemplateProvenance;
  if (parsed.kind !== 'task-template' || typeof parsed.contentHash !== 'string') {
    throw new Error(`Invalid template provenance in ${path.join(taskDir, HANDOFF_INPUT)}`);
  }
  return parsed;
}

/**
 * ADR-068 Amendment 7: the node producer imports project tooling from the slot,
 * so a written task initializes only once prepare checked out and installed it.
 * Idempotent: an initialized task, or one initialized at write-task before this
 * marker existed, is verified and never copied again.
 */
export async function completeRunTaskInitialization(
  runId: string,
  options: { emit?: (event: string, payload: unknown) => void; onlyPending?: boolean } = {},
): Promise<void> {
  const run = getRun(runId);
  if (!run?.slotId || !run.taskFile) return;
  const taskDir = path.dirname(run.taskFile);
  const marker = run.engineState?.taskInit;
  if (marker?.taskFile !== run.taskFile || marker.status !== 'pending') {
    if (!options.onlyPending && existsSync(path.join(taskDir, 'artifacts/harness-provenance.json')))
      await initializeExistingTaskRuntime(run);
    return;
  }
  options.emit?.('substep', { name: 'task-init', detail: 'Initializing the task on the slot' });
  if (existsSync(path.join(taskDir, TASK_INIT_INPUT))) await initializeWrittenTask(run);
  else await initializeExistingTaskRuntime(run);
  const templateProvenance = await readTemplateProvenanceForTask(run.taskFile);
  if (templateProvenance)
    updateRun(runId, {
      templateProvenance,
      ...(templateProvenance.executionTemplate
        ? { executionTemplate: templateProvenance.executionTemplate }
        : {}),
    });
  await copyTaskFilesToSlot(runId);
  await persistRunNow(
    updateRun(runId, {
      engineState: {
        ...getRun(runId)!.engineState,
        taskInit: { taskFile: run.taskFile, status: 'initialized' },
      },
    }),
    'task initialized',
  );
  await rm(path.join(taskDir, TASK_INIT_INPUT), { force: true });
}
