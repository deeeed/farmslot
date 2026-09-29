import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { RUNNER_PICKER_MODELS, type RunnerVisibleModelState } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { currentSessionOriginator } from '../security/work-originator.js';

import {
  getRunnerDefinition,
  isKnownRunner,
  KNOWN_RUNNERS,
  runnerArgumentValueIsSafe,
} from './registry.js';

interface VisibleModelFile {
  version: 1;
  byRunner: Record<string, string[]>;
  defaults?: Record<string, string>;
}

const MAX_MODELS = 80;

export function visibleModelsHome(): string {
  const configured = process.env.FARMSLOT_HOME?.trim();
  const root = configured?.startsWith('~/')
    ? join(homedir(), configured.slice(2))
    : configured === '~'
      ? homedir()
      : configured || join(homedir(), '.farmslot');
  const originator = currentSessionOriginator();
  if (originator.kind === 'system') return root;
  return join(
    root,
    'runner-preferences',
    createHash('sha256').update(originator.principalId).digest('hex'),
  );
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
  const defaults = (data as { defaults?: unknown }).defaults ?? {};
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults))
    throw new GatewayMethodError('INVALID_STATE', 'Saved runner defaults are not an object.');
  const checkedDefaults: Record<string, string> = {};
  for (const [runner, model] of Object.entries(defaults)) {
    if (typeof model !== 'string' || !runnerArgumentValueIsSafe(model))
      throw new GatewayMethodError('INVALID_STATE', `Invalid saved default for ${runner}.`);
    checkedDefaults[runner] = model;
  }
  return { version: 1, byRunner: cleaned, defaults: checkedDefaults };
}

export function writeVisibleModelFile(file: VisibleModelFile, home = visibleModelsHome()): void {
  const path = join(home, 'runner-visible-models.json');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
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
  const preferences = readVisibleModelFile(home);
  const saved = preferences.byRunner[runner];
  const preferredDefault = preferences.defaults?.[runner];
  const defaultModel = preferredDefault ?? getRunnerDefinition(runner).defaultModel ?? '';
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
    defaultModel,
    defaultConfigured: preferredDefault !== undefined,
    configured,
    models,
    pickerModels: [
      ...new Set(
        [...models, defaultModel, retained].filter((model): model is string => Boolean(model)),
      ),
    ],
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
