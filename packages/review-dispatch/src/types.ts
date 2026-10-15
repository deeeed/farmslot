import type {
  ReviewContinuationContext,
  ReviewMode,
  ReviewRequestContext,
  ReviewSelection,
  ReviewSequence,
  Run,
} from '@farmslot/protocol';

export interface ResolveReviewModeOptions {
  explicitMode?: ReviewMode | null;
  run?: Pick<Run, 'reviewMode' | 'prWork' | 'repeatReviewContext'> | null;
  defaultMode?: ReviewMode | null;
}

export type EffortLevel = string | null;
export interface ReviewDispatchModelOption {
  id: string;
  label?: string;
  /** Omitted inherits runner levels. Empty means only the supported default. */
  efforts?: readonly string[];
}
export interface ReviewDispatchModelPickerState {
  choices: readonly ReviewDispatchModelOption[];
  customModel: boolean;
  searchable: boolean;
}
export interface ReviewDispatchRunnerOption {
  id: string;
  label?: string;
  models: readonly ReviewDispatchModelOption[];
  defaultModel: string | null;
  efforts: readonly string[];
  defaultEffort: string | null;
  allowCustomModels?: boolean;
}
export interface ReviewDispatchCatalog {
  runners: readonly ReviewDispatchRunnerOption[];
}
export interface ReviewValidationOptions {
  catalog?: ReviewDispatchCatalog;
  allowSequence?: boolean;
  allowEmpty?: boolean;
  maxRows?: number;
  sequenceRole?: ReviewDispatchSequenceRole;
}
export type ReviewDispatchAction = 'request-review' | 'dispatch' | 'configure' | 'chat';
export type ReviewDispatchSequenceRole = 'reviews' | 'execution-alternatives';
export interface ReviewDispatchContext extends ReviewValidationOptions {
  allowedActions: readonly ReviewDispatchAction[];
  /** QA uses execution choices without static-review session eligibility. */
  workflow?: 'review' | 'qa';
  defaults?: Partial<ReviewSelection>;
  showMode?: boolean;
  minRows?: number;
  /** Caller-supplied reviewed lineages. They never derive from the selected runner. */
  reviewLineages?: readonly ReviewContinuationContext[];
  reviewContext?: ReviewRequestContext;
}
export interface ReviewDispatchViewModelOptions {
  context: ReviewDispatchContext;
  sequence?: ReviewSequence;
  catalog?: ReviewDispatchCatalog;
}
export interface ReviewDispatchRow {
  id: number;
  selection: Readonly<ReviewSelection>;
  context: Readonly<ReviewContinuationContext> | null;
}
export interface ReviewDispatchEffortChoice {
  value: string | null;
  label: string;
}
export interface ReviewDispatchState {
  rows: readonly ReviewDispatchRow[];
  errors: readonly string[];
  canAddRow: boolean;
  canRemoveRow: boolean;
}
export interface ReviewDispatchProjectDefaults {
  name: string;
  defaults?: Record<string, { runner?: string; model?: string; effort?: string }>;
  review?: Partial<ReviewSelection>;
}
export interface ReviewDispatchExecutionResources {
  allowedSlots?: string[];
  allowedMachines?: string[];
}

/** Capability defaults resolved for execution, never used to overwrite saved selections. */
export interface ResolvedReviewDispatchExecutionModel extends ReviewSelection {
  model: string;
}
