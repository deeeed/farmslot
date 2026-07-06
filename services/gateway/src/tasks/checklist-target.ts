import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentRole } from '@farmslot/protocol';

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
  TASK_PROGRESS_MARKDOWN: string;
  INTERACTIVE_CHECKLIST_MARKDOWN: string;
  WORKER_SIGNAL_FILE: string;
  ROLE_SIGNAL_SUFFIX: string;
  SELF_REVIEW_CHECKLIST: string;
  SELF_REVIEW_FIX_CHECKLIST: string;
  CI_FIX_CHECKLIST: string;
  SELF_REVIEW_CHECKLIST_TARGET: ChecklistTarget;
  SELF_REVIEW_FIX_CHECKLIST_TARGET: ChecklistTarget;
  CI_FIX_CHECKLIST_TARGET: ChecklistTarget;
  CHECKLIST_TARGET_BY_AGENT_ROLE: Record<NestedLoopAgentRole, ChecklistTarget>;
  DEFAULT_CHECKLIST_TARGET_REGISTRY: ChecklistTargetRegistry;
  checklistTargetForAgentRole: (
    role: NestedLoopAgentRole,
    registry?: ChecklistTargetRegistry,
  ) => ChecklistTarget | null;
  taskDirRelPath: (taskDir: string, basename: string) => string;
  targetForChecklistBasename: (checklistBasename: string) => ChecklistTarget;
  defaultWorkerTarget: (taskDir: string) => ChecklistTarget;
};

export interface ChecklistTarget {
  checklist: string;
  signal: string;
}

export type NestedLoopAgentRole = Extract<AgentRole, 'self-review' | 'self-review-fix' | 'ci-fix'>;

export interface ChecklistTargetRegistry {
  manifest: string;
  workerTask: string;
  interactiveChecklist: string;
  workerSignal: string;
  roleSignalSuffix: string;
  roles: Record<NestedLoopAgentRole, ChecklistTarget>;
}

export const CHECKLIST_TARGET_MANIFEST = checklistTargetLib.CHECKLIST_TARGET_MANIFEST;
export const TASK_PROGRESS_MARKDOWN = checklistTargetLib.TASK_PROGRESS_MARKDOWN;
export const INTERACTIVE_CHECKLIST_MARKDOWN = checklistTargetLib.INTERACTIVE_CHECKLIST_MARKDOWN;
export const WORKER_SIGNAL_FILE = checklistTargetLib.WORKER_SIGNAL_FILE;
export const ROLE_SIGNAL_SUFFIX = checklistTargetLib.ROLE_SIGNAL_SUFFIX;

export const SELF_REVIEW_CHECKLIST = checklistTargetLib.SELF_REVIEW_CHECKLIST;
export const SELF_REVIEW_FIX_CHECKLIST = checklistTargetLib.SELF_REVIEW_FIX_CHECKLIST;
export const CI_FIX_CHECKLIST = checklistTargetLib.CI_FIX_CHECKLIST;

export const SELF_REVIEW_CHECKLIST_TARGET = checklistTargetLib.SELF_REVIEW_CHECKLIST_TARGET;
export const SELF_REVIEW_FIX_CHECKLIST_TARGET = checklistTargetLib.SELF_REVIEW_FIX_CHECKLIST_TARGET;
export const CI_FIX_CHECKLIST_TARGET = checklistTargetLib.CI_FIX_CHECKLIST_TARGET;
export const CHECKLIST_TARGET_BY_AGENT_ROLE = checklistTargetLib.CHECKLIST_TARGET_BY_AGENT_ROLE;
export const DEFAULT_CHECKLIST_TARGET_REGISTRY =
  checklistTargetLib.DEFAULT_CHECKLIST_TARGET_REGISTRY;

export function targetForChecklistBasename(checklistBasename: string): ChecklistTarget {
  return checklistTargetLib.targetForChecklistBasename(checklistBasename);
}

export function defaultWorkerChecklistTarget(taskAbsDir: string): ChecklistTarget {
  return checklistTargetLib.defaultWorkerTarget(taskAbsDir);
}

export function checklistTargetForAgentRole(
  role: NestedLoopAgentRole,
  registry: ChecklistTargetRegistry = DEFAULT_CHECKLIST_TARGET_REGISTRY,
): ChecklistTarget {
  const target = checklistTargetLib.checklistTargetForAgentRole(role, registry);
  if (!target) {
    throw new Error(`No checklist target registered for agent role '${role}'`);
  }
  return target;
}

export function taskDirRelPath(
  taskDir: string,
  basename: string,
  _registry: ChecklistTargetRegistry = DEFAULT_CHECKLIST_TARGET_REGISTRY,
): string {
  return checklistTargetLib.taskDirRelPath(taskDir, basename);
}

export function slotTaskRelPath(
  vars: Pick<Awaited<ReturnType<typeof loadSlotVars>>, 'remoteRepo'>,
  taskDir: string,
  basename: string,
): string {
  return `${vars.remoteRepo}/${taskDirRelPath(taskDir, basename)}`;
}

function manifestRelPath(taskDir: string): string {
  return taskDirRelPath(taskDir, CHECKLIST_TARGET_MANIFEST);
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
  await syncChecklistTarget(vars, taskDir, targetForChecklistBasename(checklistBasename));
}

export async function syncChecklistTargetForRole(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  role: NestedLoopAgentRole,
  registry: ChecklistTargetRegistry = DEFAULT_CHECKLIST_TARGET_REGISTRY,
): Promise<void> {
  await syncChecklistTarget(vars, taskDir, checklistTargetForAgentRole(role, registry));
}

export async function syncChecklistTarget(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  target: ChecklistTarget,
): Promise<void> {
  await writeTextFileOnSlot(vars, manifestRelPath(taskDir), serializeManifest(target));
}

export async function restoreWorkerChecklistTargetOnSlot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  preferInteractiveChecklist = false,
  registry: ChecklistTargetRegistry = DEFAULT_CHECKLIST_TARGET_REGISTRY,
): Promise<void> {
  const checklist = preferInteractiveChecklist
    ? registry.interactiveChecklist
    : registry.workerTask;
  await syncChecklistTargetOnSlot(vars, taskDir, checklist);
}

export async function restoreWorkerChecklistTargetFromSlot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  registry: ChecklistTargetRegistry = DEFAULT_CHECKLIST_TARGET_REGISTRY,
): Promise<void> {
  const checklistPath = slotTaskRelPath(vars, taskDir, registry.interactiveChecklist);
  const probe = await execOnSlot(
    vars,
    `test -f ${shellQuote(checklistPath)} && echo yes`,
    vars.remoteRepo,
  );
  const preferInteractive = probe.stdout.trim() === 'yes';
  await restoreWorkerChecklistTargetOnSlot(vars, taskDir, preferInteractive, registry);
}

export async function writeWorkerChecklistTargetLocal(taskAbsDir: string): Promise<void> {
  await writeChecklistTargetLocal(taskAbsDir, defaultWorkerChecklistTarget(taskAbsDir));
}
