import type {
  RunnerModelCatalogResult,
  RunnerVisibleModelsGetResult,
  RunnerVisibleModelsSetResult,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { queryRunnerModelCatalog } from '../runners/model-catalog.js';
import {
  getRunnerDefinition,
  isKnownRunner,
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

export function runnerModelCatalog(params: unknown): Promise<RunnerModelCatalogResult> {
  const runner = runnerParam(params);
  const definition = getRunnerDefinition(runner);
  return queryRunnerModelCatalog(runner, definition.modelCatalog);
}

export function runnerVisibleModelsGet(params: unknown): RunnerVisibleModelsGetResult {
  const record = recordParams(params);
  const selected = optionalString(record.selectedModel);
  if (typeof record.runner === 'string' && record.runner.trim()) {
    return { runners: [describeVisibleModels(record.runner.trim(), selected)] };
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
