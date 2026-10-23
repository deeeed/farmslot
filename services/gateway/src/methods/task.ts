// methods/task.ts — Task progress parsed from the task checklist markdown file.
// Every flow stores checklist progress in CHECKLIST.md (the execution checklist);
// TASK.md is the task document and is never enumerated. The progress-path
// resolver falls back to TASK.md only for task dirs written before the split.

import path from 'node:path';

import {
  DEFAULT_TASK_DIR,
  enumerateChecklistCheckboxes,
  type Run,
  type SlotStatus,
  type TaskPhaseProgress,
  type TaskProgressParams,
  type TaskProgressResult,
  type TaskProgressStructured,
  type TaskSchema,
  type TaskStepProgress,
  type TaskStepStatus,
} from '@farmslot/protocol';

import { selectAgentContext } from '../agents/contexts.js';
import {
  getOrchestratorTaskRoot,
  loadSlotVars,
  normalizeSlotTaskRel,
  resolveTaskPaths,
  resolveTaskRelDir,
} from '../core/config.js';
import { GatewayMethodError } from '../core/method-error.js';
import {
  ORCHESTRATOR_LOCALITY,
  slotFileExists,
  type SlotLocality,
  slotReadFile,
} from '../core/slot-io.js';
import { loadFleetStatus } from '../fleet/state.js';
import { readReviewWorkspaceProgress } from '../review-workspaces/task.js';
import { loadProjectVarsOrNull } from '../run-engine/project-vars.js';
import { getRun, listRuns } from '../runs/store.js';
import { readAcceptanceStatusForDisplay } from '../tasks/acceptance-status.js';
import { attachOperations } from '../tasks/operations.js';
import {
  resolveTaskProgressMarkdownPath,
  resolveTaskProgressMarkdownPathForSlot,
} from '../tasks/progress-path.js';
import { WORKER_MIRROR_SUFFIX } from '../tasks/sidecars.js';
import {
  attachSubtaskToStep,
  buildSubtaskEntry,
  readSubtaskIndex,
  readSubtaskUnits,
  subtaskUnitsForParentChecklist,
} from '../tasks/subtasks.js';
import { generateTaskSchema } from '../tasks/writer.js';

export async function taskProgress(params: TaskProgressParams): Promise<TaskProgressResult> {
  const requested = params.runId ? getRun(params.runId) : undefined;
  if (params.runId && !requested)
    throw new GatewayMethodError('RUN_NOT_FOUND', `Run not found: ${params.runId}`);
  const runIdentity = requested ? progressRunIdentity(requested, params) : undefined;
  const slot = params.slotId
    ? (await loadFleetStatus(false, true)).slots.find((row) => row.slot === params.slotId)
    : undefined;
  const slotIdentity = JSON.stringify([slot?.currentRunId, slot?.taskFile]);
  const live =
    !requested ||
    !params.slotId ||
    (requested.slotId === params.slotId && slot?.currentRunId === requested.id);
  const result = live
    ? await readTaskProgress(params, slot, requested)
    : await recordedRunProgress(params, requested);
  if (!result)
    throw new GatewayMethodError(
      'PROGRESS_OWNER_CHANGED',
      `Run ${params.runId} no longer owns slot ${params.slotId}, and its recorded progress is unavailable.`,
    );
  if (requested) {
    const current = getRun(requested.id);
    if (!current) throw new GatewayMethodError('RUN_NOT_FOUND', `Run not found: ${requested.id}`);
    if (progressRunIdentity(current, params) !== runIdentity)
      throw new GatewayMethodError(
        'PROGRESS_OWNER_CHANGED',
        'The progress owner changed during the read.',
      );
  }
  if (live && params.slotId) {
    const current = (await loadFleetStatus(false, true)).slots.find(
      (row) => row.slot === params.slotId,
    );
    if (JSON.stringify([current?.currentRunId, current?.taskFile]) !== slotIdentity)
      throw new GatewayMethodError(
        'PROGRESS_OWNER_CHANGED',
        'The slot binding changed during the progress read.',
      );
  }
  return result;
}

function progressRunIdentity(run: Run, params: TaskProgressParams): string {
  const context = selectAgentContext(run, params);
  if ((params.contextId || params.role || params.target) && !context)
    throw new GatewayMethodError('NOT_FOUND', 'The requested progress context no longer exists.');
  return JSON.stringify([
    run.slotId,
    run.flowType,
    run.taskFile,
    run.activeTaskFile,
    run.nativeOwnerPrincipalId,
    run.reviewWorkspace,
    context?.id,
    context?.taskFile,
    context?.attemptStartedAt,
    context?.status,
    params.taskFile ? declaredProgressFiles(run) : undefined,
  ]);
}

async function readTaskProgress(
  params: TaskProgressParams,
  slot: SlotStatus | undefined,
  requested: Run | undefined,
): Promise<TaskProgressResult> {
  if (!params.slotId && params.runId) {
    // A slot-free review workspace (ADR-058) reads through its own confined task
    // directory, but everything beside the checklist is the same contract a slot
    // run has: child checklist units under `subtasks/` and the acceptance ledger
    // (ADR-060). Same read layers, same projection, so a static review reports a
    // child under its parent step exactly as a slot worker does.
    const source = await readReviewWorkspaceProgress(params.runId, undefined, params.taskFile);
    const schema = generateTaskSchema(source.markdown, 'review-pr');
    const structured = joinSchemaWithMarkdown(schema, source.markdown);
    const result: TaskProgressResult = {
      slotId: '',
      contextId: 'review',
      role: 'review',
      markdown: source.markdown,
      structured,
    };
    if (!params.taskFile) {
      await attachSubtaskProgress(source.io, source.checklistPath, 'review-pr', structured);
      await attachOperations(source.io, source.checklistPath, structured);
    }
    await attachAcceptanceStatus(source.io, source.checklistPath, result);
    return result;
  }
  if (!params.taskFile && !slot?.taskFile) {
    const recorded = requested ? await recordedRunProgress(params, requested) : null;
    if (recorded) return recorded;
    throw new Error(`No task file for slot ${params.slotId}`);
  }

  if (params.taskFile) {
    const requestedFile = params.taskFile;
    const vars = await loadSlotVars(params.slotId);
    if (
      requested &&
      !declaredProgressFiles(requested).some(
        (file) =>
          path.resolve(vars.remoteRepo, file) === path.resolve(vars.remoteRepo, requestedFile),
      )
    )
      throw new GatewayMethodError(
        'NOT_FOUND',
        'The requested progress file is not recorded for this run.',
      );
    // An explicit TASK.md (Slot View passes the worker context's task file) still
    // resolves to the sibling CHECKLIST.md when it exists; role checklists pass through.
    const effectiveMdPath = await resolveTaskProgressMarkdownPathForSlot(
      vars,
      resolveExplicitTaskFile(vars.remoteRepo, params.taskFile),
    );
    const markdown = await slotReadFile(vars, effectiveMdPath);
    const result: TaskProgressResult = {
      slotId: params.slotId,
      role: params.role,
      contextId: params.contextId,
      markdown,
    };
    const flowType = requested?.flowType ?? taskFlowTypeFromPath(params.taskFile);
    await progressFromChecklist(vars, effectiveMdPath, flowType, markdown, result);
    return result;
  }

  if (!slot?.taskFile) throw new Error(`No task file for slot ${params.slotId}`);

  // Resolve paths using slot.taskFile (relative dir, e.g. "fix/proj-2796-0403-1242")
  const { vars, taskDirName, taskMdPath } = await resolveTaskPaths(params.slotId, slot.taskFile);

  // Use activeTaskFile if the run has declared a variant (e.g. REVIEW.md)
  // activeTaskFile is absolute — extract just the filename and resolve within the task dir
  const activeRun = params.runId
    ? requested
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
  const flowType = normalizeSlotTaskRel(slot.taskFile, taskDirName).split('/')[0] || 'fix-bug';
  const schema = generateTaskSchema(markdown, flowType);
  if (schema.phases.length > 0) {
    result.structured = joinSchemaWithMarkdown(schema, markdown);
    await attachSubtaskProgress(vars, effectiveMdPath, flowType, result.structured);
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
  if (result.structured) await attachOperations(vars, effectiveMdPath, result.structured);
  await attachAcceptanceStatus(vars, effectiveMdPath, result);

  return result;
}

/**
 * Parse a checklist into steps and attach what sits beside it in the task
 * directory: child units, operation logs and the acceptance data. With no
 * markdown, only the acceptance data is attached.
 */
async function progressFromChecklist(
  io: SlotLocality,
  mdPath: string,
  flowType: string,
  markdown: string | null,
  result: TaskProgressResult,
): Promise<void> {
  if (markdown !== null) {
    const schema = generateTaskSchema(markdown, flowType);
    if (schema.phases.length > 0) {
      result.structured = joinSchemaWithMarkdown(schema, markdown);
      await attachSubtaskProgress(io, mdPath, flowType, result.structured);
      await attachOperations(io, mdPath, result.structured);
    }
  }
  await attachAcceptanceStatus(io, mdPath, result);
}

/**
 * Progress for a run whose slot no longer holds its task (released after the run
 * finished), read from the run's recorded task directory on the gateway: the copy
 * run artifacts are served from. Null when the run has no recorded copy under its
 * project's task root.
 *
 * That copy's checklist is the dispatch template. The worker's checked copy lands
 * beside it as `<checklist>.worker` at completion; without that mirror only the
 * acceptance data is reported, never the template's unchecked steps.
 */
async function recordedRunProgress(
  params: TaskProgressParams,
  run: Run,
): Promise<TaskProgressResult | null> {
  if (!run.taskFile) return null;
  const projectVars = await loadProjectVarsOrNull(run.project, 'recorded task progress', run.id);
  const taskRoot = getOrchestratorTaskRoot(run.project, projectVars?.projectJson ?? null);
  const relativeTaskDir = resolveTaskRelDir(run.taskFile, taskRoot);
  if (relativeTaskDir === null) return null;
  const io = ORCHESTRATOR_LOCALITY;
  if (!(await slotFileExists(io, run.taskFile))) return null;
  const context = selectAgentContext(run, params);
  const candidate =
    params.taskFile ??
    (params.contextId || params.role || params.target ? context?.taskFile : run.activeTaskFile) ??
    run.taskFile;
  if (params.taskFile) {
    if (!declaredProgressFiles(run).includes(params.taskFile))
      throw new GatewayMethodError(
        'NOT_FOUND',
        'The requested progress file is not recorded for this run.',
      );
  }
  const directory = path.dirname(run.taskFile);
  let recorded = candidate;
  if (candidate !== run.taskFile) {
    const normalized = candidate.replaceAll('\\', '/');
    const marker = `/${relativeTaskDir}/`;
    const offset = normalized.lastIndexOf(marker);
    const relative =
      path.isAbsolute(normalized) && !path.relative(directory, normalized).startsWith('..')
        ? path.relative(directory, normalized)
        : offset >= 0
          ? normalized.slice(offset + marker.length)
          : normalized.startsWith(`${relativeTaskDir}/`)
            ? normalized.slice(relativeTaskDir.length + 1)
            : null;
    if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) return null;
    recorded = path.join(directory, relative);
  }
  const effectiveMdPath = await resolveTaskProgressMarkdownPathForSlot(io, recorded);
  const workerCopy = `${effectiveMdPath}${WORKER_MIRROR_SUFFIX}`;
  const immutableArtifact =
    params.taskFile &&
    run.steps.some((row) => row.outputs?.taskProgressArtifactPath === params.taskFile);
  const markdown = immutableArtifact
    ? await slotReadFile(io, effectiveMdPath)
    : (await slotFileExists(io, workerCopy))
      ? await slotReadFile(io, workerCopy)
      : null;
  const result: TaskProgressResult = {
    slotId: params.slotId,
    role: context?.role,
    contextId: context?.id,
    markdown: markdown ?? '',
  };
  await progressFromChecklist(io, effectiveMdPath, run.flowType, markdown, result);
  return result;
}

function declaredProgressFiles(run: Run): string[] {
  return [
    run.taskFile,
    run.activeTaskFile,
    ...(run.agentContexts ?? []).map((row) => row.taskFile),
    ...run.steps.map((row) => row.outputs?.taskProgressArtifactPath),
  ]
    .filter((file): file is string => typeof file === 'string' && file.length > 0)
    .flatMap((file) => [file, resolveTaskProgressMarkdownPath(file)]);
}

/**
 * Attach the acceptance ledger (ADR-060) to a progress result. The ledger belongs
 * to the task directory, not to a step or a role, so every context that reads a
 * checklist in that directory reports the same verdicts — including a role
 * checklist, whose reviewer is looking at the same criteria.
 *
 * An unreadable ledger is warned about and dropped: progress must still describe
 * the run, and the terminal contract check is what refuses to close on it.
 */
async function attachAcceptanceStatus(
  vars: SlotLocality,
  effectiveMdPath: string,
  result: TaskProgressResult,
): Promise<void> {
  // Both halves: the criteria the task registered, and the verdicts recorded so
  // far. A client needs the first to show a criterion still awaiting a verdict —
  // the ledger transfers the selected engine claims, with the read error when neither
  // can be read, so the panel says "unreadable" instead of quietly showing nothing.
  const read = await readAcceptanceStatusForDisplay(vars, path.dirname(effectiveMdPath));
  if (read.criteria.length > 0) result.acceptanceCriteria = read.criteria;
  if (read.ledger) result.acceptanceStatus = read.ledger;
  if (read.error) result.acceptanceStatusError = read.error;
  // Explicitly retained historical links remain separate from verdicts. Current
  // readers never derive new acceptance relationships from manifest covers.
  if (read.source) result.acceptanceSource = read.source;
  if (read.evidenceLinks) result.acceptanceEvidenceLinks = read.evidenceLinks;
  if (read.evidenceLinksError) result.acceptanceEvidenceLinksError = read.evidenceLinksError;
}

/**
 * Attach the child-unit projection (ADR-060) to the steps that own one. Reads
 * `subtasks/index.json` beside the effective checklist and, for every unit whose
 * `parent.checklist` is that checklist's basename, builds the child's own
 * structured progress with the same schema generator and checkbox join the
 * parent uses.
 *
 * Depth stays 1 in v1: a child's own progress is built from its checklist alone,
 * so a child of a child is not read. The `subtask` field is recursive in the
 * contract, so deepening it later needs no new type.
 *
 * A missing index means the task directory has no child unit. A present but
 * invalid index throws — `mark` is its only writer, so a malformed registry is a
 * real failure the operator must see, not a reason to report a childless run.
 */
async function attachSubtaskProgress(
  vars: SlotLocality,
  effectiveMdPath: string,
  flowType: string,
  structured: TaskProgressStructured,
): Promise<void> {
  const taskDir = path.dirname(effectiveMdPath);
  const parentChecklist = path.basename(effectiveMdPath);
  const units = subtaskUnitsForParentChecklist(
    await readSubtaskIndex(vars, taskDir),
    parentChecklist,
  );
  if (units.length === 0) return;
  const nowMs = Date.now();
  for (const read of await readSubtaskUnits(vars, taskDir, units)) {
    const childSchema = generateTaskSchema(read.markdown, flowType);
    const childProgress = joinSchemaWithMarkdown(childSchema, read.markdown);
    const entry = buildSubtaskEntry(read.unit, childProgress, read.signal, nowMs);
    if (!attachSubtaskToStep(structured, read.unit.parent.stepNumber, entry)) {
      console.warn(
        `[task-progress] subtask ${read.unit.id} names ${parentChecklist} step ` +
          `${read.unit.parent.stepNumber}, which this checklist no longer has`,
      );
    }
  }
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
