import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GROK_MODEL,
  DEFAULT_PI_MODEL,
} from '../contracts/runs.js';

// Pi's Anthropic OAuth provider uses Anthropic model IDs. Keep the provider
// prefix so launch-command.ts cannot mistake them for xAI's bare model IDs.
export const PI_ANTHROPIC_MODELS = [
  'anthropic/claude-opus-5',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-haiku-4-5',
  'anthropic/claude-fable-5-1',
] as const;

/**
 * Built-in picker models per runner. Clients show these, and the gateway reports
 * them as visible models, until an operator saves a visible set for the runner.
 */
export const RUNNER_PICKER_MODELS: Readonly<Record<string, readonly string[]>> = {
  claude: ['sonnet', 'opus', 'haiku', 'fable'],
  // Astra first; retain earlier Codex models for explicit selections.
  codex: [
    DEFAULT_CODEX_MODEL,
    'gpt-6-sol',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
  ],
  // Cursor Agent IDs from `cursor-agent --list-models`. The first entry is the
  // shared protocol default used by every client.
  cursor: [
    DEFAULT_CURSOR_MODEL,
    'composer-2.5',
    'composer-2.5-fast',
    'cursor-grok-4.6-high',
    'cursor-grok-4.6-xhigh',
    'grok-4.7-high',
    'grok-4.7-xhigh',
    'gpt-5.6-sol-medium',
    'gpt-5.6-sol-high',
    'gpt-5.6-sol-max',
  ],
  grok: [DEFAULT_GROK_MODEL, 'grok-4.7'],
  pi: [DEFAULT_PI_MODEL, ...PI_ANTHROPIC_MODELS],
};

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
