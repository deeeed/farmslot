import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Run } from '@farmslot/protocol';
import { resolveProjectTaskDirName } from '@farmslot/slot-config';

import { loadProjectVars, loadSlotVars } from '../core/config.js';
import { slotFileExists } from '../core/slot-io.js';
import { getRunWithArchived } from '../runs/store.js';

import { workerTaskDirectory } from './worker-task-dir.js';

const RECEIPT = 'artifacts/harness-provenance.json';

/**
 * Why prepare must refuse a run whose task dir another run initialized, or null.
 *
 * Re-dispatching a task file after its run was cancelled or archived reuses a gateway-side dir
 * whose receipt and handoff still belong to that run, while release has removed the slot copy.
 * Task init would then treat the dir as retained and fail verification on the slot. Refusing
 * here, before any slot work, names the owner and the way out instead.
 *
 * Read-only. Not refused: a task this run just wrote, this run's own attempt (replay, resume),
 * an authored task adopted under its own author-owned attempt (no run has that id), and any task
 * whose slot copy still holds its receipt (retained verification handles it).
 */
export async function foreignTaskDirRefusal(run: Run): Promise<string | null> {
  if (!run.taskFile || !run.slotId) return null;
  const pending = run.engineState?.taskInit;
  if (pending?.taskFile === run.taskFile && pending.status === 'pending') return null;
  const taskDir = path.dirname(run.taskFile);
  if (!existsSync(path.join(taskDir, RECEIPT))) return null;
  let attemptId: unknown;
  try {
    attemptId = (
      JSON.parse(await readFile(path.join(taskDir, 'inputs/handoff.json'), 'utf8')) as {
        attemptId?: unknown;
      }
    ).attemptId;
  } catch {
    return null;
  }
  if (typeof attemptId !== 'string' || !attemptId || attemptId === run.id) return null;
  const owner = await getRunWithArchived(attemptId);
  if (!owner) return null;
  const slot = await loadSlotVars(run.slotId);
  const project = await loadProjectVars(run.project);
  const workerTaskDir = workerTaskDirectory(
    run.taskFile,
    slot.remoteRepo,
    resolveProjectTaskDirName(project.projectJson),
  );
  if (await slotFileExists(slot, path.posix.join(workerTaskDir, RECEIPT))) return null;
  return `Task dir ${taskDir} was initialized by run ${owner.id}; author a fresh task dir (copy TASK.md to a new folder) or re-dispatch with --ticket.`;
}
