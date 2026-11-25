import { existsSync } from 'node:fs';
import path from 'node:path';

import type { Run } from '@farmslot/protocol';
import { resolveProjectTaskDirName } from '@farmslot/slot-config';

import { loadProjectVars, loadSlotVars } from '../core/config.js';
import { slotFileExists } from '../core/slot-io.js';
import { BINDING_RECEIPT_FILE } from '../run-completion/run-episode.js';
import { getRunWithArchived } from '../runs/store.js';
import { readTaskHandoff } from '../tasks/existing-runtime.js';

import { workerTaskDirectory } from './worker-task-dir.js';

/**
 * Why prepare must refuse a run whose task dir another attempt initialized, or null.
 *
 * Re-dispatching a task file after its run was cancelled or archived reuses a gateway-side dir
 * whose receipt and handoff still belong to that attempt, while release has removed the slot
 * copy. Task init would then treat the dir as retained and fail verification on the slot, which
 * always needs the slot receipt. Refusing here, before slot prepare, names the owner and the way
 * out instead. The owner only shapes the wording: an author-owned attempt fails the same way.
 *
 * Read-only. Not refused: a task with no gateway receipt yet (one this run just wrote), this
 * run's own attempt (replay, resume), and any task whose slot copy still holds its receipt
 * (retained verification and authored adoption handle it). The pending task-init marker is no
 * signal: write-task sets it for a provided task file too, which is exactly this re-dispatch.
 */
export async function foreignTaskDirRefusal(run: Run): Promise<string | null> {
  if (!run.taskFile || !run.slotId) return null;
  const taskDir = path.dirname(run.taskFile);
  if (!existsSync(path.join(taskDir, BINDING_RECEIPT_FILE))) return null;
  const attemptId = (await readTaskHandoff(taskDir))?.attemptId;
  if (typeof attemptId !== 'string' || !attemptId || attemptId === run.id) return null;
  const slot = await loadSlotVars(run.slotId);
  const project = await loadProjectVars(run.project);
  const workerTaskDir = workerTaskDirectory(
    run.taskFile,
    slot.remoteRepo,
    resolveProjectTaskDirName(project.projectJson),
  );
  if (await slotFileExists(slot, path.posix.join(workerTaskDir, BINDING_RECEIPT_FILE))) return null;
  const owner = (await getRunWithArchived(attemptId)) ? `run ${attemptId}` : `attempt ${attemptId}`;
  return (
    `Task dir ${taskDir} was initialized by ${owner} (its handoff names it), and slot ${run.slotId} no longer has its copy. ` +
    'Re-dispatch with --ticket, or author a fresh task dir: copy TASK.md and CHECKLIST.md to a new folder, ' +
    'leave out artifacts/ and inputs/handoff.json, and update the task paths written inside them.'
  );
}
