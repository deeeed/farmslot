import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { RUNNER_PICKER_MODELS, type RunnerVisibleModelState } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

import {
  getRunnerDefinition,
  isKnownRunner,
  KNOWN_RUNNERS,
  runnerArgumentValueIsSafe,
} from './registry.js';

interface VisibleModelFile {
  version: 1;
  byRunner: Record<string, string[]>;
}

const MAX_MODELS = 80;

export function visibleModelsHome(): string {
  const configured = process.env.FARMSLOT_HOME?.trim();
  if (configured) return configured;
  return join(homedir(), '.farmslot');
}

export function readVisibleModelFile(home = visibleModelsHome()): VisibleModelFile {
  const path = join(home, 'runner-visible-models.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { version: 1, byRunner: {} };
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new GatewayMethodError(
      'INVALID_STATE',
      'Saved runner visible models are not valid JSON.',
    );
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new GatewayMethodError('INVALID_STATE', 'Saved runner visible models are not an object.');
  }
  const byRunner = (data as { byRunner?: unknown }).byRunner;
  if (!byRunner || typeof byRunner !== 'object' || Array.isArray(byRunner)) {
    throw new GatewayMethodError(
      'INVALID_STATE',
      'Saved runner visible models have no byRunner object.',
    );
  }
  const cleaned: Record<string, string[]> = {};
  for (const [runner, models] of Object.entries(byRunner)) {
    if (!Array.isArray(models) || models.some((model) => typeof model !== 'string')) {
      throw new GatewayMethodError(
        'INVALID_STATE',
        `Saved visible models for ${runner} are not a list of strings.`,
      );
    }
    cleaned[runner] = models;
  }
  return { version: 1, byRunner: cleaned };
}

export function writeVisibleModelFile(file: VisibleModelFile, home = visibleModelsHome()): void {
  const path = join(home, 'runner-visible-models.json');
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(tmp, path);
}

export function visibleRunners(): string[] {
  return Object.values(KNOWN_RUNNERS)
    .filter(
      (definition) =>
        definition.modelCatalog || definition.nativeChoices || definition.defaultModel,
    )
    .map((definition) => definition.id);
}

export function describeVisibleModels(
  runner: string,
  selectedModel?: string,
  home = visibleModelsHome(),
): RunnerVisibleModelState {
  if (!isKnownRunner(runner)) {
    throw new GatewayMethodError('INVALID_PARAMS', `Unknown runner '${runner}'.`);
  }
  const saved = readVisibleModelFile(home).byRunner[runner];
  const configured = Array.isArray(saved);
  const models = configured ? saved : visibleModelSeed(runner);
  const retained =
    selectedModel && selectedModel.trim() && !models.includes(selectedModel)
      ? selectedModel.trim()
      : undefined;
  if (retained && !runnerArgumentValueIsSafe(retained)) {
    throw new GatewayMethodError('INVALID_PARAMS', 'Selected model is not a safe runner argument.');
  }
  return {
    runner,
    configured,
    models,
    pickerModels: retained ? [...models, retained] : [...models],
    ...(retained ? { retainedModel: retained } : {}),
  };
}

/** Models shown before an operator saves a visible set: the same picker defaults clients show. */
function visibleModelSeed(runner: string): string[] {
  const definition = getRunnerDefinition(runner);
  const seed =
    RUNNER_PICKER_MODELS[definition.id] ??
    definition.nativeChoices?.models ??
    (definition.defaultModel ? [definition.defaultModel] : []);
  return [...seed];
}

export function assertVisibleModelList(models: unknown): string[] {
  if (!Array.isArray(models)) {
    throw new GatewayMethodError('INVALID_PARAMS', 'models must be a list of model ids.');
  }
  if (models.length > MAX_MODELS) {
    throw new GatewayMethodError('INVALID_PARAMS', `At most ${MAX_MODELS} visible models.`);
  }
  const cleaned: string[] = [];
  for (const model of models) {
    if (typeof model !== 'string' || !runnerArgumentValueIsSafe(model)) {
      throw new GatewayMethodError('INVALID_PARAMS', 'Each visible model must be a safe model id.');
    }
    const id = model.trim();
    if (!cleaned.includes(id)) cleaned.push(id);
  }
  return cleaned;
}
