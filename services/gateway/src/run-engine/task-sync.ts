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
import { usesNodeLink } from '../fleet/node-link-policy.js';
import { copyTaskThroughNodeLink } from '../fleet/node-link-task-copy.js';
import {
  invalidateArtifactTextCache,
  invalidateLiveRecipeContextMemo,
} from '../live-recipe/context.js';
import { restoreRetainedTaskArtifacts } from '../run-completion/restore-task-artifacts.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';
import { initializeExistingTaskRuntime } from '../tasks/existing-runtime.js';
import {
  CHECKLIST_MARKER_INPUT,
  copyPreparedTaskRootSidecars,
  TASK_ROOT_SIDECARS,
} from '../tasks/sidecars.js';
import { initializeWrittenTask, TASK_INIT_INPUT } from '../tasks/writer.js';

import { loadProjectVarsOrNull } from './project-vars.js';

interface TaskCopyOptions {
  slotId?: string;
  /** A reviewer with an existing marker keeps its checklist, signals and frozen inputs. */
  artifactsOnly?: boolean;
}

export async function copyTaskFilesToSlot(
  runId: string,
  options: TaskCopyOptions = {},
): Promise<void> {
  const { slotId, artifactsOnly } = options;
  const run = getRun(runId);
  if (!run?.taskFile || !(slotId ?? run.slotId)) return;

  try {
    const vars = await loadSlotVars(slotId ?? run.slotId!);
    await restoreRetainedTaskArtifacts(run);
    const pv = await loadProjectVarsOrNull(run.project, 'run recovery', run.id);
    const taskDirName = pv ? resolveProjectTaskDirName(pv.projectJson) : DEFAULT_TASK_DIR;

    const taskDir = path.dirname(run.taskFile);
    await auditBlindTrialTask(run, taskDir);
    const taskFolderId = path.basename(taskDir);
    const flowSubdir = path.basename(path.dirname(taskDir));
    const workerTaskAbs = path.join(vars.remoteRepo, taskDirName, flowSubdir, taskFolderId);

    const linked = usesNodeLink(vars.machine);
    if (linked) {
      await copyTaskThroughNodeLink(run, vars, taskDir, workerTaskAbs, artifactsOnly);
    } else if (isLocal(vars.host, vars.machine)) {
      await mkdir(workerTaskAbs, { recursive: true });
      if (!artifactsOnly) await copyFile(run.taskFile, path.join(workerTaskAbs, 'TASK.md'));
      for (const subdir of artifactsOnly ? ['artifacts'] : ['assets', 'inputs', 'artifacts']) {
        const localDir = path.join(taskDir, subdir);
        if (existsSync(localDir)) {
          // Forward task sync intentionally includes the full prepared artifact
          // tree; WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES only applies to
          // worker-to-gateway release copies where gateway-owned outputs must
          // not be overwritten.
          await cp(localDir, path.join(workerTaskAbs, subdir), {
            recursive: true,
            ...(subdir === 'artifacts' ? { force: false, errorOnExist: false } : {}),
          });
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
      if (!artifactsOnly) {
        const scpRes = await execLocal(
          `scp -q ${SSH_CONNECT_SHELL_OPTIONS} ${shellQuote(run.taskFile)} ${shellQuote(`${sshTarget}:${workerTaskAbs}/TASK.md`)}`,
        );
        if (scpRes.exitCode !== 0) {
          throw new Error(
            `scp TASK.md to ${sshTarget}:${workerTaskAbs} failed: ${scpRes.stderr.trim() || scpRes.stdout.trim() || `exit ${scpRes.exitCode}`}`,
          );
        }
      }
      for (const subdir of artifactsOnly ? ['artifacts'] : ['assets', 'inputs', 'artifacts']) {
        const localDir = path.join(taskDir, subdir);
        if (!existsSync(localDir)) continue;
        // Forward task sync intentionally includes the full prepared artifact
        // tree; WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES only applies to
        // worker-to-gateway release copies where gateway-owned outputs must
        // not be overwritten.
        const rsyncRes = await execLocal(
          `rsync -az ${subdir === 'artifacts' ? '--ignore-existing ' : ''}${RSYNC_SSH_SHELL_OPTION} ${shellQuote(`${localDir}/`)} ${shellQuote(`${sshTarget}:${workerTaskAbs}/${subdir}/`)}`,
        );
        if (rsyncRes.exitCode !== 0) {
          throw new Error(
            `rsync ${subdir}/ to ${sshTarget}:${workerTaskAbs} failed: ${rsyncRes.stderr.trim() || rsyncRes.stdout.trim() || `exit ${rsyncRes.exitCode}`}`,
          );
        }
      }
      console.log(`[run-engine] copied task files to ${sshTarget}:${workerTaskAbs}`);
    }
    const transfer = {
      taskDir,
      workerTaskAbs,
      host: vars.host,
      machine: vars.machine,
      sshTarget: vars.sshTarget,
    };
    // A missing marker admits restoration. Publish it only after the prepared
    // inputs, evidence and other sidecars, so a failed copy is retried in full.
    if (!artifactsOnly && !linked) {
      await copyPreparedTaskRootSidecars({
        ...transfer,
        excludeRelativePaths: [CHECKLIST_MARKER_INPUT],
      });
      await copyPreparedTaskRootSidecars({
        ...transfer,
        excludeRelativePaths: TASK_ROOT_SIDECARS.filter((file) => file !== CHECKLIST_MARKER_INPUT),
      });
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
