/** How a runner model catalog was obtained. Structured files only; runner text is never a source. */
export type RunnerModelCatalogSource = 'structured-file' | 'unsupported';

export type RunnerModelCatalogStatus = 'ready' | 'unavailable' | 'unsupported';

export interface RunnerCatalogModel {
  id: string;
  /** Reasoning or thinking modes the runner's structured catalog lists for this model. */
  reasoningModes: string[];
  /** Whether the runner lists this model in its default visible set. Hidden models stay in the full catalog. */
  listed: boolean;
}

export interface RunnerModelCatalogParams {
  runner: string;
}

export interface RunnerModelCatalogResult {
  runner: string;
  status: RunnerModelCatalogStatus;
  source: RunnerModelCatalogSource;
  detail?: string;
  models: RunnerCatalogModel[];
}

export interface RunnerVisibleModelsGetParams {
  runner?: string;
  /** Kept in the picker when it is outside the saved visible set. */
  selectedModel?: string;
}

export interface RunnerVisibleModelState {
  runner: string;
  /** True when the operator has saved a visible set for this runner. */
  configured: boolean;
  /** Models shown by default. The built-in seed when nothing has been saved. */
  models: string[];
  /** Visible models plus the retained explicit selection, in picker order. */
  pickerModels: string[];
  retainedModel?: string;
}

export interface RunnerVisibleModelsGetResult {
  runners: RunnerVisibleModelState[];
}

export interface RunnerVisibleModelsSetParams {
  runner: string;
  models: string[];
}

export interface RunnerVisibleModelsSetResult {
  ok: true;
  runner: RunnerVisibleModelState;
}
