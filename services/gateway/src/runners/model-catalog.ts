import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';

import {
  isPickerCatalogModel,
  type RunnerCatalogModel,
  type RunnerModelCatalogResult,
} from '@farmslot/protocol';

import {
  parsePiModelList as decodePiModelList,
  PiModelListFormatError,
} from '../../../../scripts/runners/pi-farmslot-providers.mjs';
import type { SlotVars } from '../core/config.js';

export class ModelCatalogFormatError extends Error {}

export const RUNNER_MODEL_CATALOG_TTL_MS = 5 * 60_000;

/** A runner that can read a structured model catalog. Absent means the capability is unsupported. */
export interface RunnerModelCatalogFileSource {
  /** Catalog files relative to the operator's home directory, merged in order. */
  relativePath: string | readonly string[];
  parse: (data: unknown) => RunnerCatalogModel[];
}

export interface RunnerModelCatalogCommandSource {
  command: string;
  poolPathKey?: 'cursor_path' | 'claude_path' | 'codex_path' | 'grok_path' | 'pi_path';
  args: string[];
  parse: (output: string) => RunnerCatalogModel[];
}

/** A listing command every execution node runs itself, through its slots' exec path. */
export interface RunnerModelCatalogNodeSource {
  nodeCommand: string;
  /** Slot var naming the pool's configured executable; `nodeCommand` when unset. */
  slotPathKey: 'piPath' | 'opencodePath';
  args: string[];
  /** Model ids, `provider/model`. */
  parse: (output: string) => string[] | NodeCatalogModels;
  /** Runner-owned listing command, executed with this node's inherited and pool environment. */
  buildCommand?: (vars: SlotVars, binary: string) => string;
  /** The listed id a requested model launches as, such as Pi's bare `grok-*` as `xai/grok-*`. */
  resolveModel?: (model: string) => string;
}

export type RunnerModelCatalogSource =
  | RunnerModelCatalogFileSource
  | RunnerModelCatalogCommandSource
  | RunnerModelCatalogNodeSource;

const pendingCommands = new Map<string, Promise<RunnerModelCatalogResult>>();

export async function queryRunnerModelCatalog(
  runner: string,
  source: RunnerModelCatalogFileSource | RunnerModelCatalogCommandSource | undefined,
  home = homedir(),
): Promise<RunnerModelCatalogResult> {
  if (!source || !('command' in source)) return readRunnerModelCatalog(runner, source, home);
  const key = JSON.stringify([runner, source.command, source.args]);
  const pending = pendingCommands.get(key);
  if (pending) return pending;
  const request = queryCommandCatalog(runner, source);
  pendingCommands.set(key, request);
  try {
    return await request;
  } finally {
    pendingCommands.delete(key);
  }
}

async function queryCommandCatalog(
  runner: string,
  source: RunnerModelCatalogCommandSource,
): Promise<RunnerModelCatalogResult> {
  let output: string;
  try {
    const { stdout } = await promisify(execFile)(source.command, source.args, {
      timeout: 15000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      encoding: 'utf8',
    });
    output = stdout;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const failure = error as Omit<NodeJS.ErrnoException, 'code'> & {
      code?: string | number;
      killed?: boolean;
      signal?: string;
    };
    const code = failure.code;
    if (
      !failure.killed &&
      typeof failure.signal !== 'string' &&
      typeof code !== 'number' &&
      !['ENOENT', 'EACCES', 'EPERM', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(String(code))
    )
      throw error;
    return {
      runner,
      status: 'unavailable',
      source: 'catalog-command',
      detail: `Runner catalog command failed (code: ${code ?? 'none'}, signal: ${failure.signal ?? 'none'}, killed: ${failure.killed === true}). Check the runner installation and authentication on the gateway host.`,
      models: [],
    };
  }
  try {
    return { runner, status: 'ready', source: 'catalog-command', models: source.parse(output) };
  } catch (error) {
    if (!(error instanceof ModelCatalogFormatError)) throw error;
    return {
      runner,
      status: 'unavailable',
      source: 'catalog-command',
      detail: error.message,
      models: [],
    };
  }
}

export function parseCursorModelCatalog(output: string): RunnerCatalogModel[] {
  const lines = stripVTControlCharacters(output)
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (!lines.includes('Available models'))
    throw new ModelCatalogFormatError('Missing Cursor model catalog header.');
  const models = new Map<string, RunnerCatalogModel>();
  for (const line of lines.slice(lines.indexOf('Available models') + 1)) {
    const match = /^([a-zA-Z0-9][a-zA-Z0-9._/-]*) - (.+)$/.exec(line);
    if (!match) continue;
    const [, id, label] = match;
    models.set(id, { id, label, reasoningModes: [], listed: true });
  }
  if (!models.size) throw new ModelCatalogFormatError('Cursor model catalog listed no models.');
  return [...models.values()];
}

const UNSUPPORTED_DETAIL = 'This runner does not report a model catalog.';

export function readRunnerModelCatalog(
  runner: string,
  source: RunnerModelCatalogFileSource | undefined,
  home = homedir(),
): RunnerModelCatalogResult {
  if (!source) {
    return {
      runner,
      status: 'unsupported',
      source: 'unsupported',
      detail: UNSUPPORTED_DETAIL,
      models: [],
    };
  }
  const relativePaths =
    typeof source.relativePath === 'string' ? [source.relativePath] : source.relativePath;
  const models = new Map<string, RunnerCatalogModel>();
  let foundFile = false;
  for (const relativePath of relativePaths) {
    let raw: string;
    try {
      raw = readFileSync(join(home, relativePath), 'utf8');
      foundFile = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Catalog files may be optional; report unavailable if every file is absent.
      if (code === 'ENOENT') continue;
      if (code === 'EACCES' || code === 'ENOTDIR')
        return unavailable(runner, `Structured model catalog is not readable (${code}).`);
      throw err;
    }
    try {
      for (const model of source.parse(JSON.parse(raw))) models.set(model.id, model);
    } catch (err) {
      if (err instanceof SyntaxError)
        return unavailable(runner, 'Structured model catalog is not valid JSON.');
      if (err instanceof ModelCatalogFormatError) return unavailable(runner, err.message);
      throw err;
    }
  }
  if (!models.size)
    return unavailable(
      runner,
      foundFile
        ? 'Structured model catalog listed no models.'
        : 'Structured model catalog is not readable (ENOENT).',
    );
  return { runner, status: 'ready', source: 'structured-file', models: [...models.values()] };
}

function unavailable(runner: string, detail: string): RunnerModelCatalogResult {
  return { runner, status: 'unavailable', source: 'structured-file', detail, models: [] };
}

export function parseCodexModelCatalog(data: unknown): RunnerCatalogModel[] {
  const models = arrayField(data, 'models');
  const parsed = models.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.slug !== 'string' || !entry.slug.trim()) return [];
    const levels = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels
      : [];
    const reasoningModes = levels.flatMap((level) => {
      if (!isRecord(level) || typeof level.effort !== 'string' || !level.effort.trim()) return [];
      return [level.effort];
    });
    return [
      {
        id: entry.slug,
        reasoningModes,
        listed: entry.visibility === 'list',
      },
    ];
  });
  if (parsed.length === 0)
    throw new ModelCatalogFormatError('Structured model catalog listed no models.');
  return parsed;
}

export function parseGrokModelCatalog(data: unknown): RunnerCatalogModel[] {
  if (!isRecord(data) || !isRecord(data.models)) {
    throw new ModelCatalogFormatError('Structured model catalog has no models object.');
  }
  const parsed = Object.entries(data.models).flatMap(([id, value]) => {
    if (!id.trim() || !isRecord(value)) return [];
    const info = isRecord(value.info) ? value.info : {};
    const efforts = Array.isArray(info.reasoning_efforts) ? info.reasoning_efforts : [];
    const reasoningModes = efforts.flatMap((effort) => {
      if (!isRecord(effort) || typeof effort.id !== 'string' || !effort.id.trim()) return [];
      return [effort.id];
    });
    return [{ id, reasoningModes, listed: info.hidden !== true }];
  });
  if (parsed.length === 0)
    throw new ModelCatalogFormatError('Structured model catalog listed no models.');
  return parsed;
}

/** Translate the shared Pi decoder's format failures into gateway catalog errors. */
export function parsePiModelList(output: string): string[] {
  try {
    return decodePiModelList(output);
  } catch (error) {
    if (error instanceof PiModelListFormatError) throw new ModelCatalogFormatError(error.message);
    throw error;
  }
}

/** Farmslot's node-local Pi helper reports the models actually registered by discovery. */
export function parsePiModelCatalog(output: string): NodeCatalogModels {
  // Raw tables remain valid for callers that list native Pi directly.
  if (!output.trimStart().startsWith('{')) return { ids: parsePiModelList(output) };
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new ModelCatalogFormatError('Pi model catalog is not valid JSON.');
  }
  if (
    !isRecord(value) ||
    !isModelIds(value.ids) ||
    !value.ids.length ||
    !isRecord(value.aliases) ||
    (value.nativeIds !== undefined && !isModelIds(value.nativeIds))
  )
    throw new ModelCatalogFormatError('Pi model catalog has invalid models or aliases.');
  const ids: string[] = value.ids;
  const aliases: Record<string, string> = {};
  for (const [alias, canonical] of Object.entries(value.aliases)) {
    if (
      !alias.startsWith('router/') ||
      typeof canonical !== 'string' ||
      !ids.includes(canonical) ||
      ids.includes(alias) ||
      alias.slice(7) !== canonical.slice(canonical.indexOf('/') + 1)
    )
      throw new ModelCatalogFormatError('Pi model catalog has invalid aliases.');
    aliases[alias] = canonical;
  }
  return { ids, aliases, ...(value.nativeIds === undefined ? {} : { nativeIds: value.nativeIds }) };
}

function isModelIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((id) => typeof id === 'string' && /^[a-z0-9][\w.-]*\/\S+$/i.test(id))
  );
}

/** `opencode models`: one `provider/model` per line. */
export function parseOpenCodeModelList(output: string): string[] {
  const ids = stripVTControlCharacters(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[a-z0-9][\w.-]*\/\S+$/i.test(line));
  if (!ids.length) throw new ModelCatalogFormatError('OpenCode listed no models.');
  return [...new Set(ids)];
}

interface NodeModelListing {
  nativeIds: readonly string[];
  ids: readonly string[];
  observedAt?: number;
  aliases: Readonly<Record<string, string>>;
}

/** Last good listing per runner and execution node. Stale data guides placement only. */
export class NodeModelCatalogs {
  private readonly listings = new Map<string, Map<string, NodeModelListing>>();

  record(
    runner: string,
    machine: string,
    ids: readonly string[],
    aliases: Readonly<Record<string, string>> = {},
    nativeIds: readonly string[] = Object.keys(aliases).length ? [] : ids,
  ): void {
    let byNode = this.listings.get(runner);
    if (!byNode) this.listings.set(runner, (byNode = new Map()));
    byNode.set(machine, {
      ids: [...ids],
      aliases: { ...aliases },
      nativeIds: [...nativeIds],
      observedAt: Date.now(),
    });
  }

  unavailable(runner: string, machine: string): void {
    const listing = this.listings.get(runner)?.get(machine);
    if (listing) listing.observedAt = undefined;
  }

  /** One node's full last good listing; undefined until it has listed. */
  listing(runner: string, machine: string): readonly string[] | undefined {
    const listing = this.listings.get(runner)?.get(machine);
    return listing ? [...listing.ids, ...Object.keys(listing.aliases)] : undefined;
  }

  /** Native registry evidence only; legacy synthesized catalogs cannot establish it. */
  nativeListing(runner: string, machine: string): readonly string[] | undefined {
    return this.listings.get(runner)?.get(machine)?.nativeIds;
  }

  /** Canonical picker ids, including router ids configured by this node. */
  pickerListing(runner: string, machine: string): readonly string[] | undefined {
    const listing = this.listings.get(runner)?.get(machine);
    if (!listing) return undefined;
    const configured = new Set(Object.values(listing.aliases));
    return listing.ids.filter((id) => isPickerCatalogModel(id) || configured.has(id));
  }

  /** Picker models only, each naming its nodes when some node lacks it. */
  result(runner: string): RunnerModelCatalogResult {
    const nodes = [...(this.listings.get(runner) ?? [])].sort(([a], [b]) => a.localeCompare(b));
    if (!nodes.length)
      return {
        runner,
        status: 'unavailable',
        source: 'catalog-command',
        detail: 'No execution node has listed its models yet.',
        models: [],
      };
    const listedOn = new Map<string, string[]>();
    for (const [machine] of nodes)
      for (const id of this.pickerListing(runner, machine) ?? [])
        listedOn.set(id, [...(listedOn.get(id) ?? []), machine]);
    return {
      runner,
      status: 'ready',
      source: 'catalog-command',
      models: [...listedOn].map(([id, machines]) => ({
        id,
        reasoningModes: [],
        listed: true,
        ...(machines.length < nodes.length ? { nodes: machines } : {}),
      })),
    };
  }

  /** Only a fresh successful listing can refuse a model on this node. */
  blocker(
    runner: string,
    model: string,
    machine: string,
    transport: 'tmux' | 'native' = 'tmux',
  ): string | null {
    const byNode = this.listings.get(runner);
    const listing = byNode?.get(machine);
    const contains = (entry: NodeModelListing) =>
      transport === 'native'
        ? entry.nativeIds.includes(model)
        : entry.ids.includes(model) || Object.hasOwn(entry.aliases, model);
    if (
      !byNode ||
      listing?.observedAt === undefined ||
      Date.now() - listing.observedAt >= RUNNER_MODEL_CATALOG_TTL_MS ||
      contains(listing)
    )
      return null;
    const listedOn = [...byNode]
      .filter(([, entry]) => contains(entry))
      .map(([node]) => node)
      .sort();
    return listedOn.length
      ? `${runner} model ${model} is not listed on ${machine}; only on ${listedOn.join(', ')}`
      : null;
  }
}

export const nodeModelCatalogs = new NodeModelCatalogs();

export interface NodeCatalogModels {
  ids: string[];
  nativeIds?: readonly string[];
  aliases?: Readonly<Record<string, string>>;
}

/** One execution node: `list` resolves the source command's stdout or rejects. */
export interface ModelCatalogNode {
  machine: string;
  list(source: RunnerModelCatalogNodeSource): Promise<string>;
}

export async function queryNodeModelCatalog(
  runner: string,
  source: RunnerModelCatalogNodeSource,
  nodes: readonly ModelCatalogNode[],
  store = nodeModelCatalogs,
): Promise<RunnerModelCatalogResult> {
  await Promise.all(
    nodes.map(async (node) => {
      const ids = await listNodeModels(runner, source, node);
      if (ids) store.record(runner, node.machine, ids.ids, ids.aliases, ids.nativeIds);
      else store.unavailable(runner, node.machine);
    }),
  );
  return store.result(runner);
}

/** A failed command or parse leaves the node's last good listing intact. */
export async function listNodeModels(
  runner: string,
  source: RunnerModelCatalogNodeSource,
  node: ModelCatalogNode,
): Promise<NodeCatalogModels | undefined> {
  try {
    const ids = source.parse(await node.list(source));
    return Array.isArray(ids) ? { ids } : ids;
  } catch (error) {
    console.warn(
      `[runner-models] ${runner} model list on ${node.machine} failed; keeping its last listing: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function arrayField(data: unknown, key: string): unknown[] {
  if (!isRecord(data) || !Array.isArray(data[key])) {
    throw new ModelCatalogFormatError(`Structured model catalog has no ${key} array.`);
  }
  return data[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
