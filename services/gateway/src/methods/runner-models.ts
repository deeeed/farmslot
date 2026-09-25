import type {
  RunnerModelCatalogResult,
  RunnerVisibleModelsGetResult,
  RunnerVisibleModelsSetResult,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { readRunnerModelCatalog } from '../runners/model-catalog.js';
import { getRunnerDefinition, isKnownRunner, normalizeRunner } from '../runners/registry.js';
import {
  assertVisibleModelList,
  describeVisibleModels,
  readVisibleModelFile,
  visibleModelsHome,
  visibleRunners,
  writeVisibleModelFile,
} from '../runners/visible-models.js';

export function runnerModelCatalog(params: unknown): RunnerModelCatalogResult {
  const runner = runnerParam(params);
  const definition = getRunnerDefinition(runner);
  return readRunnerModelCatalog(runner, definition.modelCatalog);
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
  const models = assertVisibleModelList(record.models);
  const home = visibleModelsHome();
  const file = readVisibleModelFile(home);
  file.byRunner[runner] = models;
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
