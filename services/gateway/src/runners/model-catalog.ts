import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';

import type { RunnerCatalogModel, RunnerModelCatalogResult } from '@farmslot/protocol';

export class ModelCatalogFormatError extends Error {}

/** A runner that can read a structured model catalog. Absent means the capability is unsupported. */
export interface RunnerModelCatalogFileSource {
  /** Catalog files relative to the operator's home directory, merged in order. */
  relativePath: string | readonly string[];
  /** Decode the runner's file syntax; strict JSON is the default. */
  decode?: (raw: string) => unknown;
  parse: (data: unknown) => RunnerCatalogModel[];
}

export interface RunnerModelCatalogCommandSource {
  command: string;
  poolPathKey?: 'cursor_path' | 'claude_path' | 'codex_path' | 'grok_path' | 'pi_path';
  args: string[];
  parse: (output: string) => RunnerCatalogModel[];
}

export type RunnerModelCatalogSource =
  | RunnerModelCatalogFileSource
  | RunnerModelCatalogCommandSource;

const pendingCommands = new Map<string, Promise<RunnerModelCatalogResult>>();

export async function queryRunnerModelCatalog(
  runner: string,
  source: RunnerModelCatalogSource | undefined,
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
      for (const model of source.parse((source.decode ?? JSON.parse)(raw)))
        models.set(model.id, model);
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

/** Pi permits a BOM, line comments and trailing commas, preserving string literals. */
export function decodePiModelCatalog(raw: string): unknown {
  return JSON.parse(
    raw
      .replace(/^\uFEFF/, '')
      .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ''))
      .replace(
        /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
        (match, tail: string | undefined) => tail ?? match,
      ),
  );
}

export function parsePiModelCatalog(data: unknown): RunnerCatalogModel[] {
  if (!isRecord(data))
    throw new ModelCatalogFormatError('Structured model catalog is not an object.');
  const parsed: RunnerCatalogModel[] = [];
  const configuredProviders = isRecord(data.providers) ? data.providers : null;
  const providers = configuredProviders ?? data;
  for (const [provider, value] of Object.entries(providers)) {
    if (!isRecord(value) || !Array.isArray(value.models)) continue;
    for (const model of value.models) {
      if (!isRecord(model) || typeof model.id !== 'string' || !model.id.trim()) continue;
      const id =
        !configuredProviders && model.id.includes('/') ? model.id : `${provider}/${model.id}`;
      const map = isRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : null;
      // Only modes the store actually names. A boolean reasoning flag is not a mode list.
      const reasoningModes = map ? Object.keys(map) : [];
      parsed.push({ id, reasoningModes, listed: true });
    }
  }
  if (parsed.length === 0 && !configuredProviders && Object.keys(data).length > 0)
    throw new ModelCatalogFormatError('Structured model catalog listed no models.');
  return parsed;
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
