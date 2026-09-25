import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { RunnerCatalogModel, RunnerModelCatalogResult } from '@farmslot/protocol';

/** A runner that can read a structured model catalog. Absent means the capability is unsupported. */
export interface RunnerModelCatalogSource {
  /** Path relative to the operator's home directory. Not runner stdout. */
  relativePath: string;
  parse: (data: unknown) => RunnerCatalogModel[];
}

const UNSUPPORTED_DETAIL = 'This runner does not report a model catalog.';

export function readRunnerModelCatalog(
  runner: string,
  source: RunnerModelCatalogSource | undefined,
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
