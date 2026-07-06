import type { AgentRole } from './contracts/index.js';

export const CHECKLIST_TARGET_MANIFEST = 'checklist-target.json';
export const TASK_PROGRESS_MARKDOWN = 'TASK.md';
export const INTERACTIVE_CHECKLIST_MARKDOWN = 'CHECKLIST.md';
export const WORKER_SIGNAL_FILE = 'SIGNAL.json';
export const ROLE_SIGNAL_SUFFIX = '-SIGNAL.json';

export const SELF_REVIEW_CHECKLIST = 'SELF-REVIEW.md';
export const SELF_REVIEW_FIX_CHECKLIST = 'SELF-REVIEW-FIX.md';
export const CI_FIX_CHECKLIST = 'CI-FIX.md';

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

const SIGNAL_REGISTRY_DEFAULTS = {
  workerTask: TASK_PROGRESS_MARKDOWN,
  interactiveChecklist: INTERACTIVE_CHECKLIST_MARKDOWN,
  workerSignal: WORKER_SIGNAL_FILE,
  roleSignalSuffix: ROLE_SIGNAL_SUFFIX,
} satisfies Pick<
  ChecklistTargetRegistry,
  'workerTask' | 'interactiveChecklist' | 'workerSignal' | 'roleSignalSuffix'
>;

export function signalFileForChecklist(
  checklistBasename: string,
  registry: Pick<
    ChecklistTargetRegistry,
    'workerTask' | 'interactiveChecklist' | 'workerSignal' | 'roleSignalSuffix'
  > = SIGNAL_REGISTRY_DEFAULTS,
): string {
  if (
    checklistBasename === registry.workerTask ||
    checklistBasename === registry.interactiveChecklist
  ) {
    return registry.workerSignal;
  }
  const base = checklistBasename.replace(/\.md$/i, '');
  return `${base}${registry.roleSignalSuffix}`;
}

export function targetForChecklistBasename(
  checklistBasename: string,
  registry: Pick<
    ChecklistTargetRegistry,
    'workerTask' | 'interactiveChecklist' | 'workerSignal' | 'roleSignalSuffix'
  > = SIGNAL_REGISTRY_DEFAULTS,
): ChecklistTarget {
  return {
    checklist: checklistBasename,
    signal: signalFileForChecklist(checklistBasename, registry),
  };
}

export const SELF_REVIEW_CHECKLIST_TARGET = targetForChecklistBasename(SELF_REVIEW_CHECKLIST);
export const SELF_REVIEW_FIX_CHECKLIST_TARGET =
  targetForChecklistBasename(SELF_REVIEW_FIX_CHECKLIST);
export const CI_FIX_CHECKLIST_TARGET = targetForChecklistBasename(CI_FIX_CHECKLIST);

export const CHECKLIST_TARGET_BY_AGENT_ROLE: Record<NestedLoopAgentRole, ChecklistTarget> = {
  'self-review': SELF_REVIEW_CHECKLIST_TARGET,
  'self-review-fix': SELF_REVIEW_FIX_CHECKLIST_TARGET,
  'ci-fix': CI_FIX_CHECKLIST_TARGET,
};

export const DEFAULT_CHECKLIST_TARGET_REGISTRY: ChecklistTargetRegistry = {
  manifest: CHECKLIST_TARGET_MANIFEST,
  workerTask: TASK_PROGRESS_MARKDOWN,
  interactiveChecklist: INTERACTIVE_CHECKLIST_MARKDOWN,
  workerSignal: WORKER_SIGNAL_FILE,
  roleSignalSuffix: ROLE_SIGNAL_SUFFIX,
  roles: CHECKLIST_TARGET_BY_AGENT_ROLE,
};

export function checklistTargetForAgentRole(
  role: NestedLoopAgentRole,
  registry: ChecklistTargetRegistry = DEFAULT_CHECKLIST_TARGET_REGISTRY,
): ChecklistTarget | null {
  return registry.roles[role] ?? null;
}

export function agentRoleForChecklistBasename(
  checklistBasename: string,
  registry: ChecklistTargetRegistry = DEFAULT_CHECKLIST_TARGET_REGISTRY,
): NestedLoopAgentRole | null {
  for (const role of Object.keys(registry.roles) as NestedLoopAgentRole[]) {
    if (registry.roles[role].checklist === checklistBasename) {
      return role;
    }
  }
  return null;
}

export function checklistBasenameFromTaskPath(taskPath: string | null | undefined): string | null {
  if (!taskPath) return null;
  const basename = taskPath.split('/').pop();
  return basename || null;
}

export function taskDirRelPath(taskDir: string, basename: string): string {
  const normalized = String(taskDir).replace(/\/+$/, '');
  return `${normalized}/${basename}`;
}

export interface TaskProgressAcceptanceRun {
  activeTaskFile?: string | null;
  taskFile?: string | null;
}

export interface TaskProgressAcceptanceUpdate {
  contextId?: string | null;
  role?: string | null;
}

export function shouldAcceptTaskProgressUpdate(
  run: TaskProgressAcceptanceRun | null,
  update: TaskProgressAcceptanceUpdate,
  registry: ChecklistTargetRegistry = DEFAULT_CHECKLIST_TARGET_REGISTRY,
): boolean {
  const activeTaskFile = run?.activeTaskFile;
  if (!activeTaskFile || activeTaskFile === run?.taskFile) return true;
  const activeName = checklistBasenameFromTaskPath(activeTaskFile);
  if (!activeName) return true;
  const expectedRole = agentRoleForChecklistBasename(activeName, registry);
  if (!expectedRole) return true;
  const contextId = update.contextId ?? update.role ?? null;
  return contextId === expectedRole;
}

export type PipelineProgressStep = 'monitor' | 'self-review' | 'ci-watch' | null;

export function nestedLoopProgressLabel(
  activeStep: PipelineProgressStep,
  activeTaskBasename: string | null | undefined,
  registry: ChecklistTargetRegistry = DEFAULT_CHECKLIST_TARGET_REGISTRY,
): string {
  if (activeStep === 'self-review') {
    const role = agentRoleForChecklistBasename(activeTaskBasename ?? '', registry);
    if (role === 'self-review-fix') return 'Self-review Fix Progress';
    return 'Self-review Progress';
  }
  if (activeStep === 'ci-watch') return 'CI Fix Progress';
  return 'Worker Progress';
}
