import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  runnerModelCatalogResourceKey,
  type RunnerModelCatalogResult,
  type RunnerVisibleModelsGetResult,
  type RunnerVisibleModelsSetResult,
} from '@farmslot/protocol';

import { loadMachinePool } from '../core/config.js';
import { isLocal } from '../core/exec.js';
import { GatewayMethodError } from '../core/method-error.js';
import { loadPoolConfigs } from '../fleet/state.js';
import { resourceRevisions } from '../resources/revisions.js';
import type { RunnerModelCatalogSource } from '../runners/model-catalog.js';
import {
  RUNNER_MODEL_CATALOG_TICK_MS,
  RunnerModelCatalogObservation,
  type RunnerModelCatalogReadInterest,
} from '../runners/model-catalog-observation.js';
import {
  getRunnerDefinition,
  isKnownRunner,
  KNOWN_RUNNERS,
  normalizeRunner,
  runnerArgumentValueIsSafe,
  runnerSupportsModel,
} from '../runners/registry.js';
import {
  assertVisibleModelList,
  describeVisibleModels,
  readVisibleModelFile,
  visibleModelsHome,
  visibleRunners,
  writeVisibleModelFile,
} from '../runners/visible-models.js';

async function selectRunnerModelCatalogSource(
  runner: string,
): Promise<RunnerModelCatalogSource | undefined> {
  let source = getRunnerDefinition(runner).modelCatalog;
  if (source && 'command' in source && source.poolPathKey) {
    const pools = await loadPoolConfigs();
    for (const pool of pools.filter((entry) => isLocal(entry.host, entry.machine))) {
      const configured = (await loadMachinePool(pool.machine))[source.poolPathKey]?.trim();
      if (configured) {
        source = {
          ...source,
          command: configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured,
        };
        break;
      }
    }
  }
  return source;
}

let hasCatalogInterest: (runner: string) => boolean = () => false;
let activeCatalogObservation: object | undefined;
const catalogObservation = new RunnerModelCatalogObservation({
  runners: () =>
    Object.values(KNOWN_RUNNERS)
      .filter((definition) => definition.modelCatalog)
      .map((definition) => definition.id),
  select: selectRunnerModelCatalogSource,
  hasInterest: (runner) => hasCatalogInterest(runner),
  changed: (runner) => resourceRevisions.advance(runnerModelCatalogResourceKey({ runner })),
});

export async function runnerModelCatalog(
  params: unknown,
  interest?: RunnerModelCatalogReadInterest,
): Promise<RunnerModelCatalogResult> {
  return catalogObservation.read(runnerParam(params), interest);
}

export function wakeRunnerModelCatalogObservation(): Promise<void> {
  return catalogObservation.tick();
}

/** `hasInterest` answers for one canonical runner's admitted catalog observers. */
export function startRunnerModelCatalogObservation(options: {
  hasInterest(runner: string): boolean;
}): () => Promise<void> {
  if (activeCatalogObservation)
    throw new Error('Runner model catalog observation is already running');
  const owner = {};
  activeCatalogObservation = owner;
  hasCatalogInterest = options.hasInterest;
  catalogObservation.start();
  const timer = setInterval(() => void catalogObservation.tick(), RUNNER_MODEL_CATALOG_TICK_MS);
  timer.unref();
  return async () => {
    if (activeCatalogObservation !== owner) return;
    clearInterval(timer);
    hasCatalogInterest = () => false;
    await catalogObservation.stop();
    if (activeCatalogObservation === owner) activeCatalogObservation = undefined;
  };
}

export function runnerVisibleModelsGet(params: unknown): RunnerVisibleModelsGetResult {
  const record = recordParams(params);
  const selected = optionalString(record.selectedModel);
  if (record.runner !== undefined) {
    return { runners: [describeVisibleModels(runnerParam(record), selected)] };
  }
  return { runners: visibleRunners().map((runner) => describeVisibleModels(runner)) };
}

export function runnerVisibleModelsSet(params: unknown): RunnerVisibleModelsSetResult {
  const record = recordParams(params);
  const runner = runnerParam(record);
  const models = record.models === undefined ? undefined : assertVisibleModelList(record.models);
  const changesDefault = Object.hasOwn(record, 'defaultModel');
  if (models === undefined && !changesDefault)
    throw new GatewayMethodError('INVALID_PARAMS', 'Provide models or defaultModel.');
  const defaultModel = record.defaultModel;
  if (
    changesDefault &&
    defaultModel !== null &&
    (typeof defaultModel !== 'string' ||
      !runnerArgumentValueIsSafe(defaultModel) ||
      !runnerSupportsModel(runner, defaultModel.trim()))
  )
    throw new GatewayMethodError(
      'INVALID_PARAMS',
      'Default model must be a valid model id for this runner, or null to reset.',
    );
  const home = visibleModelsHome();
  const file = readVisibleModelFile(home);
  if (models !== undefined) file.byRunner[runner] = models;
  if (changesDefault) {
    file.defaults ??= {};
    if (defaultModel === null) delete file.defaults[runner];
    else file.defaults[runner] = (defaultModel as string).trim();
  }
  writeVisibleModelFile(file, home);
  return { ok: true, runner: describeVisibleModels(runner, undefined, home) };
}

function runnerParam(params: unknown): string {
  const record = recordParams(params);
  const runner = optionalString(record.runner);
  if (!runner) throw new GatewayMethodError('INVALID_PARAMS', 'runner is required.');
  if (!isKnownRunner(runner)) {
    throw new GatewayMethodError('INVALID_PARAMS', `Unknown runner '${runner}'.`);
  }
  return normalizeRunner(runner);
}

function recordParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new GatewayMethodError('INVALID_PARAMS', 'Expected an object.');
  }
  return params as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') {
    throw new GatewayMethodError('INVALID_PARAMS', 'Expected a string.');
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}
