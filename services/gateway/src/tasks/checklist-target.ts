import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CHECKLIST_TARGET_MANIFEST,
  type ChecklistTarget,
  checklistTargetForAgentRole as resolveChecklistTargetForRole,
  type ChecklistTargetRegistry,
  DEFAULT_CHECKLIST_TARGET_REGISTRY,
  type NestedLoopAgentRole,
  targetForChecklistBasename,
  taskDirRelPath,
} from '@farmslot/protocol/checklist-target';

export type { ChecklistTarget, ChecklistTargetRegistry, NestedLoopAgentRole };

export {
  agentRoleForChecklistBasename,
  CHECKLIST_TARGET_BY_AGENT_ROLE,
  CHECKLIST_TARGET_MANIFEST,
  checklistBasenameFromTaskPath,
  CI_FIX_CHECKLIST,
  CI_FIX_CHECKLIST_TARGET,
  DEFAULT_CHECKLIST_TARGET_REGISTRY,
  INTERACTIVE_CHECKLIST_MARKDOWN,
  nestedLoopProgressLabel,
  REVIEW_CHECKLIST,
  REVIEW_CHECKLIST_TARGET,
  REVIEW_FIX_CHECKLIST,
  REVIEW_FIX_CHECKLIST_TARGET,
  ROLE_SIGNAL_SUFFIX,
  shouldAcceptTaskProgressUpdate,
  signalFileForChecklist,
  targetForChecklistBasename,
  TASK_PROGRESS_MARKDOWN,
  taskDirRelPath,
  WORKER_SIGNAL_FILE,
} from '@farmslot/protocol/checklist-target';

import type { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { writeTextFileOnSlot } from '../methods/dispatch/slot-file-write.js';

import { syncTerminalContractForFlowOnSlot } from './worker-terminal-contract.js';

export function checklistTargetForAgentRole(
  role: NestedLoopAgentRole,
  registry: ChecklistTargetRegistry = DEFAULT_CHECKLIST_TARGET_REGISTRY,
): ChecklistTarget {
  const target = resolveChecklistTargetForRole(role, registry);
  if (!target) {
    throw new Error(`No checklist target registered for agent role '${role}'`);
  }
  return target;
}

export function checklistMarkerCommand(taskDir: string, target: ChecklistTarget): string {
  return `${taskDir}/mark --checklist ${target.checklist} --signal ${target.signal}`;
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
  // Same shape the recipe-cook skill writes: the signal file is explicit so a
  // reader never has to derive it from the checklist name.
  return `${JSON.stringify({ checklist: target.checklist, signal: target.signal }, null, 2)}\n`;
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

interface RoleTerminalOptions {
  reportPath?: string;
  additionalArtifactPaths?: readonly string[];
  target?: ChecklistTarget;
  ciBaseRef?: string | null;
}

export async function syncChecklistTargetForRole(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  role: NestedLoopAgentRole,
  terminal?: RoleTerminalOptions,
  registry: ChecklistTargetRegistry = DEFAULT_CHECKLIST_TARGET_REGISTRY,
): Promise<void> {
  const target = terminal?.target ?? checklistTargetForAgentRole(role, registry);
  await syncChecklistTarget(vars, taskDir, target);
  await syncTerminalContractForFlowOnSlot(
    vars,
    taskDir,
    role,
    undefined,
    terminal?.reportPath,
    target.checklist,
    terminal?.additionalArtifactPaths,
    terminal?.ciBaseRef,
  );
}

export async function syncChecklistTarget(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  target: ChecklistTarget,
): Promise<void> {
  // The task producer owns its marker and tooling selection. Role changes only
  // select a checklist; rewriting mark would discard the task's frozen CLI gates.
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
  // The worker target is what the mark engine derives when no manifest exists
  // (CHECKLIST.md when present, else TASK.md; SIGNAL.json). Restoring it means
  // removing the role switch's manifest, not writing the default back.
  if (registry === DEFAULT_CHECKLIST_TARGET_REGISTRY) {
    await execOnSlot(
      vars,
      `rm -f ${shellQuote(`${vars.remoteRepo}/${manifestRelPath(taskDir)}`)}`,
      vars.remoteRepo,
    );
    return;
  }
  await syncChecklistTargetOnSlot(vars, taskDir, checklist);
}

export async function restoreWorkerChecklistTargetFromSlot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  terminal?: { flowType: string; mode?: string | null },
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
  if (terminal) {
    await syncTerminalContractForFlowOnSlot(vars, taskDir, terminal.flowType, terminal.mode);
  }
}
