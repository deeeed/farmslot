import { canonicalResourceJson, type ResourceKey } from '../client-cache/keys.js';
import { normalizeRunner } from '../contracts/runner-ids.js';
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GROK_MODEL,
  DEFAULT_PI_MODEL,
} from '../contracts/runs.js';

import { Methods } from './registry.js';
import type { UpstreamObservation } from './resource-observers.js';

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
  codex: [
    DEFAULT_CODEX_MODEL,
    'gpt-6-sol',
    'gpt-6-astra',
    'gpt-6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
  ],
  // Cursor Agent IDs from `cursor-agent --list-models`. The first entry is the
  // shared protocol default used by every client.
  cursor: [
    DEFAULT_CURSOR_MODEL,
    'cursor-grok-4.6-high-fast',
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

/** How a runner model catalog was obtained. */
export type RunnerModelCatalogSource =
  | 'structured-file'
  | 'catalog-command'
  | 'unsupported'
  | 'unavailable';

export type RunnerModelCatalogStatus = 'ready' | 'unavailable' | 'unsupported';

export interface RunnerCatalogModel {
  id: string;
  label?: string;
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
  /** Retained last-success models. A failed source keeps them with its original success time. */
  models: RunnerCatalogModel[];
  /** Present for gateway-collected sources; absent for runners without a catalog. */
  observation?: UpstreamObservation;
}

export interface RunnerVisibleModelsGetParams {
  runner?: string;
  /** Kept in the picker when it is outside the saved visible set. */
  selectedModel?: string;
}

export interface RunnerVisibleModelState {
  runner: string;
  defaultModel: string;
  defaultConfigured: boolean;
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
  models?: string[];
  defaultModel?: string | null;
}

export interface RunnerVisibleModelsSetResult {
  ok: true;
  runner: RunnerVisibleModelState;
}

const MAX_OBSERVED_ID_LENGTH = 256;

function observationRecord(params: unknown, allowed: readonly string[]): Record<string, unknown> {
  const input = params ?? {};
  if (typeof input !== 'object' || Array.isArray(input))
    throw new Error('Runner model observations require an object');
  const record = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(record).some((key) => !allowed.includes(key)))
    throw new Error('Runner model observations do not accept commands, paths or refreshes');
  return record;
}

/** The gateway's runner spelling, including aliases such as claude-code. */
function observationRunner(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_OBSERVED_ID_LENGTH)
    throw new Error('Runner model observations require a runner');
  return normalizeRunner(value);
}

/** An alias reads its canonical runner's catalog, so both spellings share one query. */
export function runnerModelCatalogObservationParams(params: unknown): RunnerModelCatalogParams {
  return { runner: observationRunner(observationRecord(params, ['runner']).runner) };
}

/** Model IDs are not path selectors: provider-prefixed IDs such as `anthropic/...` stay valid. */
export function runnerVisibleModelsObservationParams(
  params: unknown,
): RunnerVisibleModelsGetParams {
  const record = observationRecord(params, ['runner', 'selectedModel']);
  const selected = record.selectedModel;
  if (selected !== null && selected !== undefined && typeof selected !== 'string')
    throw new Error('selectedModel must be a model id');
  // The gateway applies a selection only to one runner's picker.
  if (record.runner === undefined) return {};
  const runner = observationRunner(record.runner);
  const selectedModel = typeof selected === 'string' ? selected.trim() : '';
  if (!selectedModel) return { runner };
  if (selectedModel.startsWith('-') || selectedModel.length > MAX_OBSERVED_ID_LENGTH)
    throw new Error('selectedModel must be a model id');
  return { runner, selectedModel };
}

/** Catalogs are gateway-host sources. The key never names a command, argv or catalog path. */
export function runnerModelCatalogResourceKey(params: unknown): ResourceKey {
  return {
    family: 'upstream',
    integration: 'providers',
    queryId: `${Methods.RUNNER_MODEL_CATALOG}:${canonicalResourceJson(runnerModelCatalogObservationParams(params))}`,
  };
}

/** Durable catalog: IDs, labels, reasoning/visibility fields and the source observation only. */
export function runnerModelCatalogStoredData(data: unknown): RunnerModelCatalogResult {
  const result = data as RunnerModelCatalogResult;
  const observation = result.observation;
  return {
    runner: result.runner,
    status: result.status,
    source: result.source,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
    models: result.models.map(({ id, label, reasoningModes, listed }) => ({
      id,
      ...(label === undefined ? {} : { label }),
      reasoningModes: [...reasoningModes],
      listed,
    })),
    ...(observation
      ? {
          observation: {
            status: observation.status,
            ...(observation.observedAt === undefined ? {} : { observedAt: observation.observedAt }),
            ...(observation.error
              ? { error: { code: observation.error.code, message: observation.error.message } }
              : {}),
          },
        }
      : {}),
  };
}

/** Durable preferences: visible IDs, defaults and the retained explicit selection only. */
export function runnerVisibleModelsStoredData(data: unknown): RunnerVisibleModelsGetResult {
  const result = data as RunnerVisibleModelsGetResult;
  return {
    runners: result.runners.map((state) => ({
      runner: state.runner,
      defaultModel: state.defaultModel,
      defaultConfigured: state.defaultConfigured,
      configured: state.configured,
      models: [...state.models],
      pickerModels: [...state.pickerModels],
      ...(state.retainedModel === undefined ? {} : { retainedModel: state.retainedModel }),
    })),
  };
}
