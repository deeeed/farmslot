// methods/task.ts — Task progress parsed from the task checklist markdown file.
// Interactive lightweight dev stores checkboxes in CHECKLIST.md; the generated
// `mark` helper prefers that file too. Autonomous templates keep progress in TASK.md.

import path from 'node:path';

import {
  DEFAULT_TASK_DIR,
  enumerateChecklistCheckboxes,
  type TaskPhaseProgress,
  type TaskProgressParams,
  type TaskProgressResult,
  type TaskProgressStructured,
  type TaskSchema,
  type TaskStepProgress,
  type TaskStepStatus,
} from '@farmslot/protocol';

import { selectAgentContext } from '../agents/contexts.js';
import { loadSlotVars, resolveTaskPaths } from '../core/config.js';
import { slotReadFile } from '../core/slot-io.js';
import { loadFleetStatus } from '../fleet/state.js';
import { getRun, listRuns } from '../runs/store.js';
import { resolveTaskProgressMarkdownPathForSlot } from '../tasks/progress-path.js';
import { generateTaskSchema } from '../tasks/writer.js';

export async function taskProgress(params: TaskProgressParams): Promise<TaskProgressResult> {
  const fleet = await loadFleetStatus();
  const slot = fleet.slots.find((s) => s.slot === params.slotId);
  if (!slot && !params.taskFile) throw new Error(`No task file for slot ${params.slotId}`);

  if (params.taskFile) {
    const vars = await loadSlotVars(params.slotId);
    const effectiveMdPath = resolveExplicitTaskFile(vars.remoteRepo, params.taskFile);
    const markdown = await slotReadFile(vars, effectiveMdPath);
    const result: TaskProgressResult = {
      slotId: params.slotId,
      role: params.role,
      contextId: params.contextId,
      markdown,
    };
    const flowType = taskFlowTypeFromPath(params.taskFile);
    const schema = generateTaskSchema(markdown, flowType);
    if (schema.phases.length > 0) result.structured = joinSchemaWithMarkdown(schema, markdown);
    return result;
  }

  if (!slot?.taskFile) throw new Error(`No task file for slot ${params.slotId}`);

  // Resolve paths using slot.taskFile (relative dir, e.g. "fix/proj-2796-0403-1242")
  const { vars, taskMdPath } = await resolveTaskPaths(params.slotId, slot.taskFile);

  // Use activeTaskFile if the run has declared a variant (e.g. SELF-REVIEW.md)
  // activeTaskFile is absolute — extract just the filename and resolve within the task dir
  const activeRun = params.runId
    ? getRun(params.runId)
    : slot.currentRunId
      ? (getRun(slot.currentRunId) ??
        listRuns({ active: true }).runs.find((r) => r.slotId === params.slotId))
      : listRuns({ active: true }).runs.find((r) => r.slotId === params.slotId);
  let effectiveMdPath = taskMdPath;
  const hasExplicitContext = !!(params.contextId || params.role || params.target);
  const context = activeRun ? selectAgentContext(activeRun, params) : null;
  if (
    !hasExplicitContext &&
    activeRun?.activeTaskFile &&
    activeRun.activeTaskFile !== activeRun.taskFile
  ) {
    const taskFile = activeRun.activeTaskFile;
    effectiveMdPath = path.isAbsolute(taskFile) ? taskFile : path.join(vars.remoteRepo, taskFile);
  } else if (context?.taskFile) {
    const taskFile = context.taskFile;
    effectiveMdPath = path.isAbsolute(taskFile) ? taskFile : path.join(vars.remoteRepo, taskFile);
  }
  effectiveMdPath = await resolveTaskProgressMarkdownPathForSlot(vars, effectiveMdPath);
  const markdown = await slotReadFile(vars, effectiveMdPath);
  const result: TaskProgressResult = {
    slotId: params.slotId,
    role: context?.role ?? params.role,
    contextId: context?.id ?? params.contextId,
    markdown,
  };

  // Parse structure directly from active task file — no schema file needed
  const flowType = slot.taskFile.split('/')[0] || 'fix-bug';
  const schema = generateTaskSchema(markdown, flowType);
  if (schema.phases.length > 0) {
    result.structured = joinSchemaWithMarkdown(schema, markdown);
    // Self-review (and similar) templates' last step is "write SIGNAL.json + /exit".
    // The worker exits before it can mark the box `[x]`, so the markdown stays at
    // N-1/N forever even though the role's signal already declared completion.
    // When the agent context status is complete and exactly one step remains
    // unchecked, treat the highest-index unchecked step as done. Conservative
    // (only flips on N-1/N) to avoid masking real failures.
    if (context?.status === 'complete') {
      reconcileFinalStepFromSignal(result.structured);
    }
  }

  return result;
}

function resolveExplicitTaskFile(remoteRepo: string, taskFile: string): string {
  const normalized = taskFile.replace(/\\/g, '/');
  const candidate = path.isAbsolute(normalized)
    ? path.normalize(normalized)
    : path.normalize(path.join(remoteRepo, normalized));
  const root = path.normalize(remoteRepo);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Task file ${taskFile} is outside slot repo`);
  }
  return candidate;
}

function taskFlowTypeFromPath(taskFile: string): string {
  const normalized = taskFile.replace(/\\/g, '/');
  const idx = normalized.indexOf(`${DEFAULT_TASK_DIR}/`);
  if (idx >= 0) {
    return normalized.slice(idx + DEFAULT_TASK_DIR.length + 1).split('/')[0] || 'fix-bug';
  }
  return normalized.split('/')[0] || 'fix-bug';
}

export function reconcileFinalStepFromSignal(structured: TaskProgressStructured): void {
  if (structured.totalSteps === 0) return;
  if (structured.completedSteps !== structured.totalSteps - 1) return;
  for (let i = structured.phases.length - 1; i >= 0; i--) {
    const phase = structured.phases[i];
    for (let j = phase.steps.length - 1; j >= 0; j--) {
      const step = phase.steps[j];
      if (step.status !== 'done') {
        step.status = 'done';
        phase.completedSteps++;
        structured.completedSteps++;
        structured.currentPhase = null;
        structured.currentStep = null;
        return;
      }
    }
  }
}

export function joinSchemaWithMarkdown(
  schema: TaskSchema,
  markdown: string,
): TaskProgressStructured {
  // Parse checkbox states from markdown (sequential index)
  const checkboxStates = parseCheckboxStates(markdown);

  let completedSteps = 0;
  let foundFirstPending = false;
  let currentPhase: string | null = null;
  let currentStep: string | null = null;

  const phases: TaskPhaseProgress[] = schema.phases.map((phase) => {
    let phaseCompleted = 0;

    const steps: TaskStepProgress[] = phase.steps.map((step) => {
      // step.index is 1-based, checkboxStates is 0-based
      const isDone = checkboxStates[step.index - 1] ?? false;

      let status: TaskStepStatus;
      if (isDone) {
        status = 'done';
        phaseCompleted++;
        completedSteps++;
      } else if (!foundFirstPending) {
        status = 'running';
        foundFirstPending = true;
        currentPhase = phase.name;
        currentStep = step.name;
      } else {
        status = 'pending';
      }

      const result: TaskStepProgress = {
        index: step.index,
        name: step.name,
        status,
      };
      if (step.artifacts) result.artifacts = step.artifacts;
      return result;
    });

    return {
      name: phase.name,
      steps,
      completedSteps: phaseCompleted,
      totalSteps: phase.steps.length,
    };
  });

  return {
    schema,
    phases,
    completedSteps,
    totalSteps: schema.totalSteps,
    currentPhase,
    currentStep,
  };
}

// Shared enumeration from @farmslot/protocol — the same logic
// generateTaskSchema and the agent-runtime `mark` helper use, so checkbox
// states always align with schema indices and marked boxes.
function parseCheckboxStates(markdown: string): boolean[] {
  return enumerateChecklistCheckboxes(markdown).map((item) => item.checked);
}
