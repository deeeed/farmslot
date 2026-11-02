import { canonicalResourceJson, type ResourceKey } from '../client-cache/keys.js';
import { normalizeRunner } from '../contracts/runner-ids.js';
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GROK_MODEL,
} from '../contracts/runs.js';

import { Methods } from './registry.js';
import type { UpstreamObservation } from './resource-observers.js';

/**
 * Built-in picker models per runner. Clients show these, and the gateway reports
 * them as visible models, until an operator saves a visible set for the runner.
 * Pi and OpenCode have none: their pickers list each execution node's own catalog.
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
  grok: [DEFAULT_GROK_MODEL],
};

/** Node catalog providers the picker shows, in group order. Every other provider is hidden. */
export const RUNNER_MODEL_PROVIDER_LABELS: ReadonlyMap<string, string> = new Map([
  ['litellm', 'Consensys LiteLLM'],
  ['xai', 'xAI'],
  ['anthropic', 'Anthropic'],
  ['omlx', 'Local'],
  ['lmstudio', 'Local'],
]);

/** Picker group of a `provider/model` id; undefined for an unprefixed id or a hidden provider. */
export function runnerModelProviderLabel(id: string): string | undefined {
  const slash = id.indexOf('/');
  return slash > 0 ? RUNNER_MODEL_PROVIDER_LABELS.get(id.slice(0, slash)) : undefined;
}

/**
 * Whether a node catalog id belongs in the picker: a labelled provider, and not an old
 * generation by model name whatever the provider (Claude 4.x and older, Grok before 4.7).
 */
export function isPickerCatalogModel(id: string): boolean {
  if (!runnerModelProviderLabel(id)) return false;
  const name = id.slice(id.lastIndexOf('/') + 1).toLowerCase();
  const claude = /^claude-(?:[a-z]+-)?(\d+)/.exec(name);
  if (claude) return Number(claude[1]) >= 5;
  const grok = /^grok-(\d+)(?:[.-](\d+))?/.exec(name);
  if (grok) {
    const [major, minor] = [Number(grok[1]), Number(grok[2] ?? 0)];
    return major > 4 || (major === 4 && minor >= 7);
  }
  return true;
}

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
  /** Per-node catalogs only: the execution nodes that list this model, when some node does not. */
  nodes?: string[];
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
  /** Models shown by default. The built-in seed when nothing has been saved; empty for Pi and OpenCode. */
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

/** Durable catalog: IDs, labels, reasoning/visibility/node fields and the source observation only. */
export function runnerModelCatalogStoredData(data: unknown): RunnerModelCatalogResult {
  const result = data as RunnerModelCatalogResult;
  const observation = result.observation;
  return {
    runner: result.runner,
    status: result.status,
    source: result.source,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
    models: result.models.map(({ id, label, reasoningModes, listed, nodes }) => ({
      id,
      ...(label === undefined ? {} : { label }),
      reasoningModes: [...reasoningModes],
      listed,
      ...(nodes === undefined ? {} : { nodes: [...nodes] }),
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
