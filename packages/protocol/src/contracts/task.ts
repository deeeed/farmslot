import type { WorkerSignalStatus } from '../transport/signal.js';

export type TaskStepStatus = 'pending' | 'done' | 'running' | 'skipped';

/** Where a child checklist unit's markdown came from (ADR-060). */
export type SubtaskSourceKind = 'skill' | 'template' | 'inline';

export interface SubtaskSource {
  kind: SubtaskSourceKind;
  /** Skill path or catalog template id; absent for `inline` text. */
  ref?: string;
  /** Digest of the source markdown before rendering. */
  sha256: string;
  /** Digest of the child checklist as written. */
  renderedSha256: string;
}

export interface TaskSchema {
  flowType: string;
  title: string;
  totalSteps: number;
  phases: TaskSchemaPhase[];
}

export interface TaskSchemaPhase {
  name: string;
  steps: TaskSchemaStep[];
}

export interface TaskSchemaStep {
  index: number;
  name: string;
  artifacts?: string[];
}

export interface TaskProgressStructured {
  schema: TaskSchema;
  phases: TaskPhaseProgress[];
  completedSteps: number;
  totalSteps: number;
  /** Optional task-local command observations from the harness. */
  operations?: TaskOperation[];
  operationsError?: string;
  currentPhase: string | null;
  currentStep: string | null;
}

export interface TaskPhaseProgress {
  name: string;
  steps: TaskStepProgress[];
  completedSteps: number;
  totalSteps: number;
}

export interface TaskStepProgress {
  index: number;
  name: string;
  status: TaskStepStatus;
  artifacts?: string[];
  /** The child unit owning this step, when one is registered. Filled by the gateway. */
  subtask?: TaskStepSubtaskProgress;
}

/**
 * Projection of a child checklist unit under its parent step. `stale` is a
 * gateway projection for a `running` child with no recent mark event; it never
 * appears in the child signal file.
 */
export interface TaskStepSubtaskProgress {
  id: string;
  status: WorkerSignalStatus | 'stale';
  source: SubtaskSource;
  /** Recursive: the child's own step projection, built by the same parser. */
  progress: TaskProgressStructured;
  lastEventAt: string | null;
}

/** Observed command execution; checklist completion and proof verdicts are separate. */
export interface TaskOperation {
  schemaVersion: 1;
  id: string;
  parentId?: string;
  command: string;
  target: string;
  pid: number;
  processStartedAt: string;
  startedAt: string;
  updatedAt: string;
  stage?: string;
  stageStartedAt?: string;
  lastOutputAt?: string;
  finishedAt?: string;
  status: 'running' | 'pass' | 'fail';
  exitCode?: number;
  logPath: string;
}

/** Reject malformed observations before observers calculate ages or inspect owners. */
export function validateOperationRecord(value: TaskOperation, id: string): void {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.id !== id ||
    !['running', 'pass', 'fail'].includes(value.status) ||
    typeof value.command !== 'string' ||
    typeof value.target !== 'string' ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.processStartedAt !== 'string' ||
    !value.processStartedAt ||
    typeof value.startedAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    (value.parentId !== undefined && typeof value.parentId !== 'string') ||
    (value.stage !== undefined && typeof value.stage !== 'string') ||
    [value.stageStartedAt, value.lastOutputAt, value.finishedAt].some(
      (at) => at !== undefined && (typeof at !== 'string' || !Number.isFinite(Date.parse(at))),
    ) ||
    (value.status !== 'running' && (!value.finishedAt || !Number.isInteger(value.exitCode))) ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    typeof value.logPath !== 'string'
  )
    throw new Error(`Invalid operation record: ${id}`);
}
