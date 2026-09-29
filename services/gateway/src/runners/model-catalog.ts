import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';

import type { RunnerCatalogModel, RunnerModelCatalogResult } from '@farmslot/protocol';

/** A runner that can read a structured model catalog. Absent means the capability is unsupported. */
export interface RunnerModelCatalogFileSource {
  /** Path relative to the operator's home directory. Not runner stdout. */
  relativePath: string;
  parse: (data: unknown) => RunnerCatalogModel[];
}

export interface RunnerModelCatalogCommandSource {
  command: string;
  args: string[];
  parse: (output: string) => RunnerCatalogModel[];
}

export type RunnerModelCatalogSource =
  | RunnerModelCatalogFileSource
  | RunnerModelCatalogCommandSource;

export async function queryRunnerModelCatalog(
  runner: string,
  source: RunnerModelCatalogSource | undefined,
  home = homedir(),
): Promise<RunnerModelCatalogResult> {
  if (!source || !('command' in source)) return readRunnerModelCatalog(runner, source, home);
  try {
    const { stdout } = await promisify(execFile)(source.command, source.args, {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      encoding: 'utf8',
    });
    return { runner, status: 'ready', source: 'catalog-command', models: source.parse(stdout) };
  } catch (error) {
    return {
      runner,
      status: 'unavailable',
      source: 'catalog-command',
      detail:
        error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? 'Runner catalog command is not installed on the gateway host.'
          : 'Runner catalog query failed or returned an invalid model list. Retry when the runner is available.',
      models: [],
    };
  }
}

export function parseCursorModelCatalog(output: string): RunnerCatalogModel[] {
  const lines = stripVTControlCharacters(output)
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (!lines.includes('Available models')) throw new Error('Missing Cursor model catalog header.');
  const models = new Map<string, RunnerCatalogModel>();
  for (const line of lines.slice(lines.indexOf('Available models') + 1)) {
    const match = /^([a-zA-Z0-9][a-zA-Z0-9._/-]*) - (.+)$/.exec(line);
    if (!match) continue;
    const [, id, label] = match;
    models.set(id, { id, label, reasoningModes: [], listed: true });
  }
  if (!models.size) throw new Error('Cursor model catalog listed no models.');
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
  const file = join(home, source.relativePath);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // A missing or unreadable catalog is an expected offline state. Other
    // filesystem failures are not, and must surface.
    if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
      return unavailable(runner, `Structured model catalog is not readable (${code}).`);
    }
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // The file exists but is not JSON. Treat that as unavailable rather than
    // guessing models from any other runner output.
    return unavailable(runner, 'Structured model catalog is not valid JSON.');
  }
  try {
    return {
      runner,
      status: 'ready',
      source: 'structured-file',
      models: source.parse(data),
    };
  } catch (err) {
    // The parser rejects a file that is not this runner's catalog shape.
    const detail = err instanceof Error ? err.message : 'Structured model catalog is not usable.';
    return unavailable(runner, detail);
  }
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
  if (parsed.length === 0) throw new Error('Structured model catalog listed no models.');
  return parsed;
}

export function parseGrokModelCatalog(data: unknown): RunnerCatalogModel[] {
  if (!isRecord(data) || !isRecord(data.models)) {
    throw new Error('Structured model catalog has no models object.');
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
  if (parsed.length === 0) throw new Error('Structured model catalog listed no models.');
  return parsed;
}

export function parsePiModelCatalog(data: unknown): RunnerCatalogModel[] {
  if (!isRecord(data)) throw new Error('Structured model catalog is not an object.');
  const parsed: RunnerCatalogModel[] = [];
  for (const [provider, value] of Object.entries(data)) {
    if (!isRecord(value) || !Array.isArray(value.models)) continue;
    for (const model of value.models) {
      if (!isRecord(model) || typeof model.id !== 'string' || !model.id.trim()) continue;
      const id = model.id.includes('/') ? model.id : `${provider}/${model.id}`;
      const map = isRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : null;
      // Only modes the store actually names. A boolean reasoning flag is not a mode list.
      const reasoningModes = map ? Object.keys(map) : [];
      parsed.push({ id, reasoningModes, listed: true });
    }
  }
  if (parsed.length === 0) throw new Error('Structured model catalog listed no models.');
  return parsed;
}

function arrayField(data: unknown, key: string): unknown[] {
  if (!isRecord(data) || !Array.isArray(data[key])) {
    throw new Error(`Structured model catalog has no ${key} array.`);
  }
  return data[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
