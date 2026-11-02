import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { RUNNER_PICKER_MODELS, type RunnerVisibleModelState } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import {
  NativeCatalogChanges,
  nativeCatalogChanges,
  NativeCatalogPreferenceSource,
  type NativeCatalogSourceReceipt,
} from '../resources/native-catalog-changes.js';
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
  const identity = preferenceIdentity(home);
  const nativeBefore = identity && fingerprintBeforeWrite(nativeCatalogProjection, home);
  const visibleBefore = identity && fingerprintBeforeWrite(visibleModelProjection, home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(file, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  // Notification follows the durable rename. Explicit unrelated homes keep their existing behavior.
  if (identity) {
    try {
      notifyPreferenceWriter(nativeCatalogProjection, identity, home, nativeBefore);
    } finally {
      notifyPreferenceWriter(visibleModelProjection, identity, home, visibleBefore);
    }
  }
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

interface PreferenceIdentity {
  key: string;
  ownerId: string;
  ownerGeneration: number;
}
interface SharedPreferenceSource {
  source: NativeCatalogPreferenceSource;
  references: number;
}
interface PreferenceProjection {
  label: string;
  sources: Map<string, SharedPreferenceSource>;
  fingerprint(home: string): string;
  changes: NativeCatalogChanges;
}

/** Owner/generation notices for every runner's visible-model read, including non-native runners. */
export const visibleModelPreferenceChanges = new NativeCatalogChanges();

const nativeCatalogProjection: PreferenceProjection = {
  label: 'Native catalog',
  sources: new Map(),
  fingerprint: nativeCatalogPreferenceFingerprint,
  changes: nativeCatalogChanges,
};
const visibleModelProjection: PreferenceProjection = {
  label: 'Visible model preference',
  sources: new Map(),
  fingerprint: visibleModelPreferenceFingerprint,
  changes: visibleModelPreferenceChanges,
};

function fingerprintBeforeWrite(
  projection: PreferenceProjection,
  home: string,
): string | undefined {
  try {
    return projection.fingerprint(home);
  } catch (error) {
    // A durable write can repair malformed preferences. Other filesystem errors still propagate.
    if (!(error instanceof GatewayMethodError && error.code === 'INVALID_STATE')) throw error;
  }
}

function notifyPreferenceWriter(
  projection: PreferenceProjection,
  identity: PreferenceIdentity,
  home: string,
  before: string | undefined,
): void {
  const source = projection.sources.get(identity.key)?.source;
  if (source) source.sample();
  else if (before !== projection.fingerprint(home))
    projection.changes.preferencesChanged(identity.ownerId, identity.ownerGeneration);
}

function preferenceIdentity(home: string): PreferenceIdentity | undefined {
  const originator = currentSessionOriginator();
  if (originator.kind !== 'principal' || resolve(home) !== resolve(visibleModelsHome())) return;
  const ownerGeneration = originator.principalGeneration ?? 0;
  return {
    key: JSON.stringify([resolve(home), originator.principalId, ownerGeneration]),
    ownerId: originator.principalId,
    ownerGeneration,
  };
}

/** Exact native catalog projection only. Other runner settings and JSON formatting stay quiet. */
function nativeCatalogPreferenceFingerprint(home: string): string {
  return JSON.stringify(
    Object.values(KNOWN_RUNNERS)
      .filter((definition) => definition.nativeTransport && definition.nativeChoices)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((definition) => {
        const visible = describeVisibleModels(definition.id, undefined, home);
        const defaultModel =
          (visible.defaultConfigured && visible.defaultModel) ||
          definition.nativeChoices!.defaultModel ||
          definition.defaultModel ||
          '';
        const models = visible.configured ? visible.models : definition.nativeChoices!.models;
        return {
          runner: definition.id,
          defaultModel,
          models:
            defaultModel && !models.includes(defaultModel) ? [defaultModel, ...models] : models,
        };
      }),
  );
}

/** Full projection of every runner's read. JSON formatting and unrelated files stay quiet. */
function visibleModelPreferenceFingerprint(home: string): string {
  return JSON.stringify(
    Object.keys(KNOWN_RUNNERS)
      .sort()
      .map((runner) => describeVisibleModels(runner, undefined, home)),
  );
}

export interface NativeCatalogPreferenceLease {
  sample(): NativeCatalogSourceReceipt;
  dispose(): void;
}

/** Acquire once per existing authenticated connection's catalog interest, not once per panel/read.
 * No file or directory is created while arming. Last release closes the shared watcher. */
export function observeNativeCatalogPreferences(
  home = visibleModelsHome(),
): NativeCatalogPreferenceLease {
  return observePreferences(nativeCatalogProjection, home);
}

/** Same lease contract for runner.visibleModels.get observers. Notices arrive through
 * visibleModelPreferenceChanges with the reader's owner and generation. */
export function observeVisibleModelPreferences(
  home = visibleModelsHome(),
): NativeCatalogPreferenceLease {
  return observePreferences(visibleModelProjection, home);
}

function observePreferences(
  projection: PreferenceProjection,
  home: string,
): NativeCatalogPreferenceLease {
  const identity = preferenceIdentity(home);
  if (!identity)
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      `${projection.label} source requires its authenticated preference home`,
    );
  let shared = projection.sources.get(identity.key);
  if (!shared) {
    shared = {
      source: new NativeCatalogPreferenceSource(
        join(resolve(home), 'runner-visible-models.json'),
        () => projection.fingerprint(home),
        (reason) =>
          projection.changes.preferencesChanged(identity.ownerId, identity.ownerGeneration, reason),
      ),
      references: 0,
    };
    projection.sources.set(identity.key, shared);
  }
  shared.references++;
  const owned = shared;
  let disposed = false;
  return {
    sample: () => {
      if (disposed)
        throw new GatewayMethodError('AUTH_FORBIDDEN', `${projection.label} connection ended`);
      return owned.source.sample();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (--owned.references === 0) {
        owned.source.close();
        projection.sources.delete(identity.key);
      }
    },
  };
}
