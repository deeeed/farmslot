export type TaskStepStatus = 'pending' | 'done' | 'running' | 'skipped';

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
}
