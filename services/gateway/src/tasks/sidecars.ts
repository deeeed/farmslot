import { existsSync } from 'node:fs';
import { chmod, copyFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  CHECKLIST_TARGET_MANIFEST,
  INTERACTIVE_CHECKLIST_MARKDOWN,
  SUBTASKS_DIR,
} from '@farmslot/protocol/checklist-target';

import { execLocal, isLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';

export const CHECKLIST_MARKER_INPUT = 'mark';
// CHECKLIST.md is a task-root file like the marker and manifest: when the
// gateway writes it (split task document, interactive dev) it must travel
// with TASK.md, or `checklist-target.json` points at a file the slot lacks.
export const TASK_ROOT_SIDECARS = [
  CHECKLIST_MARKER_INPUT,
  CHECKLIST_TARGET_MANIFEST,
  INTERACTIVE_CHECKLIST_MARKDOWN,
] as const;

/**
 * Task-directory subdirectories that travel to the slot as directories, copied
 * by every path that stages a task dir on a worker: dispatch, tmux nudge, and
 * warm-session handoff. One list so the three cannot drift — `subtasks/`
 * (ADR-060) was the copy a fourth hand-maintained array would have missed.
 */
export const TASK_DIR_COPIED_SUBDIRS = ['assets', 'inputs', 'artifacts', SUBTASKS_DIR] as const;

/**
 * Suffix of the orchestrator-side worker mirror (`CHECKLIST.md.worker`,
 * `subtasks/<id>.md.worker`). Mirror output is written BY the gateway FROM the
 * slot at completion, so it must never travel back the other way: a re-dispatch,
 * nudge, or warm handoff of a task dir that already completed once would
 * otherwise litter the worker's directory with stale copies of its own files.
 */
export const WORKER_MIRROR_SUFFIX = '.worker';

/** True for a mirror artifact the slot must never receive. */
export function isWorkerMirrorEntry(name: string): boolean {
  return path.basename(name).endsWith(WORKER_MIRROR_SUFFIX);
}

export interface CopyTaskDirSubdirectoriesParams {
  taskDir: string;
  workerTaskAbs: string;
  host: string;
  machine: string;
  sshTarget?: string;
}

/**
 * Stage `TASK_DIR_COPIED_SUBDIRS` on the worker, skipping the orchestrator's own
 * `*.worker` mirror output. One implementation for dispatch, tmux nudge, and
 * warm-session handoff: the copy used to be written out three times, which is how
 * `subtasks/` came to be missing from all three.
 *
 * Returns the subdirectory names actually copied, in list order, so each caller
 * can report its own progress steps.
 */
export async function copyTaskDirSubdirectories(
  params: CopyTaskDirSubdirectoriesParams,
): Promise<string[]> {
  const local = isLocal(params.host, params.machine);
  const copied: string[] = [];

  for (const subdir of TASK_DIR_COPIED_SUBDIRS) {
    const source = path.join(params.taskDir, subdir);
    if (!existsSync(source)) continue;
    const dest = path.join(params.workerTaskAbs, subdir);

    if (local) {
      await cp(source, dest, {
        recursive: true,
        // Called for the root and every entry; a rejected path is not descended.
        filter: (entry) => !isWorkerMirrorEntry(entry),
      });
    } else {
      if (!params.sshTarget) throw new Error(`missing ssh target for ${subdir}/ copy`);
      const result = await execLocal(
        `rsync -az --exclude=${shellQuote(`*${WORKER_MIRROR_SUFFIX}`)} ` +
          `${shellQuote(`${source}/`)} ${shellQuote(`${params.sshTarget}:${dest}/`)}`,
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `rsync ${subdir}/ to ${params.sshTarget}:${dest} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
        );
      }
    }
    copied.push(subdir);
  }

  return copied;
}

export interface CopyPreparedTaskRootSidecarsParams {
  taskDir: string;
  workerTaskAbs: string;
  host: string;
  machine: string;
  sshTarget?: string;
}

export async function copyPreparedTaskRootSidecars(
  params: CopyPreparedTaskRootSidecarsParams,
): Promise<string[]> {
  const copied: string[] = [];
  const local = isLocal(params.host, params.machine);

  for (const sidecar of TASK_ROOT_SIDECARS) {
    const source = path.join(params.taskDir, sidecar);
    const dest = path.join(params.workerTaskAbs, sidecar);
    if (!existsSync(source)) {
      // A fresh task dir carries no manifest: absent means the worker default.
      // A slot task dir left by an interrupted role switch may still hold one
      // that points the mark at the nested checklist, so absent at the source
      // must mean absent at the destination too.
      if (sidecar === CHECKLIST_TARGET_MANIFEST) {
        if (local) {
          await rm(dest, { force: true });
        } else {
          if (!params.sshTarget) throw new Error(`missing ssh target for ${sidecar} sidecar reset`);
          const rmRes = await execLocal(
            `ssh ${shellQuote(params.sshTarget)} ${shellQuote(`rm -f ${shellQuote(dest)}`)}`,
          );
          if (rmRes.exitCode !== 0) {
            throw new Error(
              `removing stale ${sidecar} on ${params.sshTarget}:${dest} failed: ${rmRes.stderr.trim() || rmRes.stdout.trim() || `exit ${rmRes.exitCode}`}`,
            );
          }
        }
      }
      continue;
    }

    if (local) {
      await copyFile(source, dest);
      if (sidecar === CHECKLIST_MARKER_INPUT) {
        await chmod(dest, 0o755);
      }
    } else {
      if (!params.sshTarget) throw new Error(`missing ssh target for ${sidecar} sidecar copy`);
      const scpRes = await execLocal(
        `scp -q ${shellQuote(source)} ${shellQuote(`${params.sshTarget}:${dest}`)}`,
      );
      if (scpRes.exitCode !== 0) {
        throw new Error(
          `scp ${sidecar} to ${params.sshTarget}:${dest} failed: ${scpRes.stderr.trim() || scpRes.stdout.trim() || `exit ${scpRes.exitCode}`}`,
        );
      }
      if (sidecar === CHECKLIST_MARKER_INPUT) {
        const chmodRes = await execLocal(
          `ssh ${shellQuote(params.sshTarget)} ${shellQuote(`chmod 755 ${shellQuote(dest)}`)}`,
        );
        if (chmodRes.exitCode !== 0) {
          throw new Error(
            `chmod ${sidecar} on ${params.sshTarget}:${dest} failed: ${chmodRes.stderr.trim() || chmodRes.stdout.trim() || `exit ${chmodRes.exitCode}`}`,
          );
        }
      }
    }

    copied.push(sidecar);
  }

  return copied;
}
