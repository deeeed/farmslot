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
  parse: (output: string) => string[];
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

const LISTED_PROVIDER = /^[a-z0-9][\w.-]*$/i;

/** `pi --list-models`: a whitespace table under a `provider model …` header. */
export function parsePiModelList(output: string): string[] {
  const rows = stripVTControlCharacters(output)
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/));
  const header = rows.findIndex(
    ([provider, model]) => provider === 'provider' && model === 'model',
  );
  if (header < 0) throw new ModelCatalogFormatError('Missing Pi model list header.');
  const ids = rows
    .slice(header + 1)
    .flatMap(([provider, model]) =>
      model && LISTED_PROVIDER.test(provider) ? [`${provider}/${model}`] : [],
    );
  if (!ids.length) throw new ModelCatalogFormatError('Pi listed no models.');
  return [...new Set(ids)];
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
  ids: readonly string[];
  observedAt?: number;
}

/** Last good listing per runner and execution node. Failures retain display data only. */
export class NodeModelCatalogs {
  private readonly listings = new Map<string, Map<string, NodeModelListing>>();

  record(runner: string, machine: string, ids: readonly string[]): void {
    let byNode = this.listings.get(runner);
    if (!byNode) this.listings.set(runner, (byNode = new Map()));
    byNode.set(machine, { ids: [...ids], observedAt: Date.now() });
  }

  unavailable(runner: string, machine: string): void {
    const listing = this.listings.get(runner)?.get(machine);
    if (listing) listing.observedAt = undefined;
  }

  /** One node's full last good listing; undefined until it has listed. */
  listing(runner: string, machine: string): readonly string[] | undefined {
    return this.listings.get(runner)?.get(machine)?.ids;
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
    for (const [machine, { ids }] of nodes)
      for (const id of ids)
        if (isPickerCatalogModel(id)) listedOn.set(id, [...(listedOn.get(id) ?? []), machine]);
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
  blocker(runner: string, model: string, machine: string): string | null {
    const byNode = this.listings.get(runner);
    const listing = byNode?.get(machine);
    if (
      !byNode ||
      listing?.observedAt === undefined ||
      Date.now() - listing.observedAt >= RUNNER_MODEL_CATALOG_TTL_MS ||
      listing.ids.includes(model)
    )
      return null;
    const listedOn = [...byNode]
      .filter(([, { ids }]) => ids.includes(model))
      .map(([node]) => node)
      .sort();
    return listedOn.length
      ? `${runner} model ${model} is not listed on ${machine}; only on ${listedOn.join(', ')}`
      : null;
  }
}

export const nodeModelCatalogs = new NodeModelCatalogs();

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
      try {
        store.record(runner, node.machine, source.parse(await node.list(source)));
      } catch (error) {
        store.unavailable(runner, node.machine);
        console.warn(
          `[runner-models] ${runner} model list on ${node.machine} failed; keeping its last listing: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
  return store.result(runner);
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
