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
