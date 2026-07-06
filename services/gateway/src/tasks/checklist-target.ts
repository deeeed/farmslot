import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { writeTextFileOnSlot } from '../methods/dispatch/slot-file-write.js';

const require = createRequire(import.meta.url);
const checklistTargetLib = require(
  path.resolve(
    fileURLToPath(import.meta.url),
    '../../../../../packages/agent-runtime/scripts/checklist-target.cjs',
  ),
) as {
  CHECKLIST_TARGET_MANIFEST: string;
  INTERACTIVE_CHECKLIST_MARKDOWN: string;
  TASK_PROGRESS_MARKDOWN: string;
  targetForChecklistBasename: (checklistBasename: string) => ChecklistTarget;
  defaultWorkerTarget: (taskDir: string) => ChecklistTarget;
};

export interface ChecklistTarget {
  checklist: string;
  signal: string;
}

export const CHECKLIST_TARGET_MANIFEST = checklistTargetLib.CHECKLIST_TARGET_MANIFEST;
export const TASK_PROGRESS_MARKDOWN = checklistTargetLib.TASK_PROGRESS_MARKDOWN;
export const INTERACTIVE_CHECKLIST_MARKDOWN = checklistTargetLib.INTERACTIVE_CHECKLIST_MARKDOWN;

export function targetForChecklistBasename(checklistBasename: string): ChecklistTarget {
  return checklistTargetLib.targetForChecklistBasename(checklistBasename);
}

export function defaultWorkerChecklistTarget(taskAbsDir: string): ChecklistTarget {
  return checklistTargetLib.defaultWorkerTarget(taskAbsDir);
}

function manifestRelPath(taskDir: string): string {
  return `${taskDir}/${CHECKLIST_TARGET_MANIFEST}`;
}

function serializeManifest(target: ChecklistTarget): string {
  return `${JSON.stringify({ checklist: target.checklist }, null, 2)}\n`;
}

export async function writeChecklistTargetLocal(
  taskAbsDir: string,
  target: ChecklistTarget,
): Promise<void> {
  await writeFile(
    path.join(taskAbsDir, CHECKLIST_TARGET_MANIFEST),
    serializeManifest(target),
    'utf-8',
  );
}

export async function syncChecklistTargetOnSlot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  checklistBasename: string,
): Promise<void> {
  await writeTextFileOnSlot(
    vars,
    manifestRelPath(taskDir),
    serializeManifest(targetForChecklistBasename(checklistBasename)),
  );
}

export async function restoreWorkerChecklistTargetOnSlot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  preferInteractiveChecklist = false,
): Promise<void> {
  const checklist = preferInteractiveChecklist
    ? INTERACTIVE_CHECKLIST_MARKDOWN
    : TASK_PROGRESS_MARKDOWN;
  await syncChecklistTargetOnSlot(vars, taskDir, checklist);
}

export async function restoreWorkerChecklistTargetFromSlot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
): Promise<void> {
  const checklistPath = `${vars.remoteRepo}/${taskDir}/${INTERACTIVE_CHECKLIST_MARKDOWN}`;
  const probe = await execOnSlot(
    vars,
    `test -f ${shellQuote(checklistPath)} && echo yes`,
    vars.remoteRepo,
  );
  const preferInteractive = probe.stdout.trim() === 'yes';
  await restoreWorkerChecklistTargetOnSlot(vars, taskDir, preferInteractive);
}

export async function writeWorkerChecklistTargetLocal(taskAbsDir: string): Promise<void> {
  await writeChecklistTargetLocal(taskAbsDir, defaultWorkerChecklistTarget(taskAbsDir));
}
