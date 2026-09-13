import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildMarkShim } from '@farmslot/agent-runtime';
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
  ROLE_SIGNAL_SUFFIX,
  SELF_REVIEW_CHECKLIST,
  SELF_REVIEW_CHECKLIST_TARGET,
  SELF_REVIEW_FIX_CHECKLIST,
  SELF_REVIEW_FIX_CHECKLIST_TARGET,
  shouldAcceptTaskProgressUpdate,
  signalFileForChecklist,
  targetForChecklistBasename,
  TASK_PROGRESS_MARKDOWN,
  taskDirRelPath,
  WORKER_SIGNAL_FILE,
} from '@farmslot/protocol/checklist-target';

import {
  farmslotRoot,
  loadProjectVars,
  type loadSlotVars,
  type ProjectVars,
} from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { expandTemplate } from '../core/hooks.js';
import { shellQuote } from '../core/tmux.js';
import { writeTextFileOnSlot } from '../methods/dispatch/slot-file-write.js';

import { CHECKLIST_MARKER_INPUT } from './sidecars.js';
import { syncTerminalContractForFlowOnSlot } from './worker-terminal-contract.js';

const REMOTE_FARMSLOT_DIR = '~/farmslot-node';
const localHostname = os.hostname().replace(/\.local$/, '');

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

export async function syncChecklistTargetForRole(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  role: NestedLoopAgentRole,
  terminal?: {
    reportPath?: string;
    additionalArtifactPaths?: readonly string[];
    target?: ChecklistTarget;
  },
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
  );
}

function farmslotDirForSlot(vars: Pick<Awaited<ReturnType<typeof loadSlotVars>>, 'host'>): string {
  const slotHost = vars.host.replace(/\.local$/, '');
  const onOperator =
    slotHost === 'localhost' || slotHost === '127.0.0.1' || slotHost === localHostname;
  return onOperator ? farmslotRoot : REMOTE_FARMSLOT_DIR;
}

export function checklistMarkerHelperPath(farmslotDirForSlot: string): string {
  return `${farmslotDirForSlot}/packages/agent-runtime/scripts/mark-checklist-step.cjs`.replace(
    /^~(?=\/)/,
    '$HOME',
  );
}

/**
 * The command the task's `mark` shim runs. A pack may set `vars.mark_cmd`
 * (for example `${MM_HARNESS_BIN:-mm-harness} checklist mark`) so workers get
 * the harness's gates; the default is the slot-synced agent-runtime engine.
 */
export function markCommandForSlot(
  vars: Pick<Awaited<ReturnType<typeof loadSlotVars>>, 'host'> &
    Parameters<typeof expandTemplate>[1],
  projectVars?: ProjectVars,
): string {
  const raw = projectVars?.projectJson.vars?.mark_cmd;
  if (typeof raw === 'string' && raw.trim()) return expandTemplate(raw, vars, projectVars);
  return `node ${checklistMarkerHelperPath(farmslotDirForSlot(vars))}`;
}

export async function syncChecklistMarkerOnSlot(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
): Promise<void> {
  const markRel = taskDirRelPath(taskDir, CHECKLIST_MARKER_INPUT);
  const projectVars = await loadProjectVars(vars.projectName);
  const content = buildMarkShim(markCommandForSlot(vars, projectVars));
  await writeTextFileOnSlot(vars, markRel, content);
  await execOnSlot(
    vars,
    `chmod +x ${shellQuote(`${vars.remoteRepo}/${markRel}`)}`,
    vars.remoteRepo,
  );
}

export async function syncChecklistTarget(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  target: ChecklistTarget,
): Promise<void> {
  await writeTextFileOnSlot(vars, manifestRelPath(taskDir), serializeManifest(target));
  await syncChecklistMarkerOnSlot(vars, taskDir);
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
