import type { AgentRole } from './contracts/index.js';
import { WORKER_TERMINAL_CONTRACT_INPUT } from './contracts/worker-terminal.js';

export const CHECKLIST_TARGET_MANIFEST = 'checklist-target.json';
export const TASK_PROGRESS_MARKDOWN = 'TASK.md';
export const INTERACTIVE_CHECKLIST_MARKDOWN = 'CHECKLIST.md';
export const WORKER_SIGNAL_FILE = 'SIGNAL.json';
export const ROLE_SIGNAL_SUFFIX = '-SIGNAL.json';

export const SELF_REVIEW_CHECKLIST = 'SELF-REVIEW.md';
export const SELF_REVIEW_FIX_CHECKLIST = 'SELF-REVIEW-FIX.md';
export const CI_FIX_CHECKLIST = 'CI-FIX.md';

/**
 * Sections whose checkboxes are informational (ACs, descriptions, upstream
 * PR-template fields) — not task steps. Every checklist consumer that
 * enumerates step checkboxes (gateway schema/progress parsers, the agent
 * `mark` helper) MUST apply the same skip list, or `mark N` targets a
 * different box than the one progress reporting counts as step N.
 * `pre-merge` covers upstream "Pre-merge author/reviewer checklist" sections
 * that arrive via {{PR_BODY}} interpolation.
 */
export const CHECKLIST_SKIP_SECTIONS =
  /^\**\s*(acceptance criteria|description|task|affected area|screenshots|comments|root cause|rules|recipe acs|pre-merge)/i;

export interface ChecklistCheckboxItem {
  /** 0-based line index in the source markdown. */
  lineIndex: number;
  /** 1-based step number — the number `mark N` targets. */
  stepNumber: number;
  checked: boolean;
  /** Heading text of the containing section, or null before any heading. */
  phase: string | null;
  /** Increments on every new (non-skipped) heading; -1 before any heading. */
  phaseIndex: number;
  /** Raw text after the checkbox marker, untrimmed of markdown. */
  rawLabel: string;
}

/**
 * Single source of truth for which markdown checkboxes are checklist steps.
 * Skips fenced code blocks, `<details>` bodies, and CHECKLIST_SKIP_SECTIONS.
 * The gateway schema/progress parsers and the agent-runtime `mark` helper all
 * enumerate through this logic — the CJS mirror in
 * packages/agent-runtime/scripts/checklist-target.cjs must stay behaviorally
 * identical (see test/checklist-target-sync.test.mjs).
 */
export function enumerateChecklistCheckboxes(markdown: string): ChecklistCheckboxItem[] {
  const items: ChecklistCheckboxItem[] = [];
  const lines = markdown.split('\n');
  let inCodeBlock = false;
  let inDetails = 0;
  let inSkippedSection = false;
  let phase: string | null = null;
  let phaseIndex = -1;
  let stepNumber = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const trimmed = lines[lineIndex].trim();
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const detailsOpens = (trimmed.match(/<details\b/g) ?? []).length;
    const detailsCloses = (trimmed.match(/<\/details/g) ?? []).length;
    if (detailsOpens > 0 || detailsCloses > 0) {
      inDetails = Math.max(0, inDetails + detailsOpens - detailsCloses);
      continue;
    }
    if (inDetails > 0) continue;
    if (/^#{2,}\s+[^#]/.test(trimmed)) {
      const name = trimmed.replace(/^#{2,}\s+/, '').trim();
      if (CHECKLIST_SKIP_SECTIONS.test(name)) {
        inSkippedSection = true;
        continue;
      }
      inSkippedSection = false;
      phase = name;
      phaseIndex += 1;
      continue;
    }
    if (inSkippedSection) continue;
    const match = trimmed.match(/^- \[( |x|X)\]\s*(.*)$/);
    if (!match) continue;
    stepNumber += 1;
    items.push({
      lineIndex,
      stepNumber,
      checked: match[1].toLowerCase() === 'x',
      phase,
      phaseIndex,
      rawLabel: match[2],
    });
  }
  return items;
}

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

export function terminalContractInputForChecklist(checklistBasename: string): string {
  if (
    checklistBasename === TASK_PROGRESS_MARKDOWN ||
    checklistBasename === INTERACTIVE_CHECKLIST_MARKDOWN
  ) {
    return WORKER_TERMINAL_CONTRACT_INPUT;
  }
  const base = checklistBasename.replace(/\.md$/i, '');
  return `inputs/worker-terminal-contract.${base}.json`;
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
