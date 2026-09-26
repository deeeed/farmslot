import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Run } from '@farmslot/protocol';

import { resolveRunsDir } from './paths.js';

/**
 * The runs directory also holds other stores' JSON (`runtime-capabilities-<port>.json`).
 * A file is a run record only when its payload id names the file and it carries the
 * fields every run reader dereferences (`status`, `steps`, `createdAt`); anything else
 * is not a run to load, migrate, or rewrite. Shared with the Gateway run store.
 */
export function parseRunRecordFile(name: string, raw: string): Run | null {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Partial<Record<'id' | 'status' | 'steps' | 'createdAt', unknown>>;
  if (typeof record.id !== 'string' || record.id === '' || name !== `${record.id}.json`) {
    return null;
  }
  if (typeof record.status !== 'string' || !Array.isArray(record.steps)) return null;
  if (typeof record.createdAt !== 'string') return null;
  return parsed as Run;
}

function readRunRecordFile(runsDir: string, name: string): Run | null {
  return parseRunRecordFile(name, readFileSync(path.join(runsDir, name), 'utf-8'));
}

export function loadRunRecord(runsDir: string, runId: string): Run | null {
  if (existsSync(path.join(runsDir, `${runId}.json`))) {
    return readRunRecordFile(runsDir, `${runId}.json`);
  }
  for (const name of readdirSync(runsDir)) {
    if (!name.endsWith('.json') || !name.startsWith(runId)) continue;
    const run = readRunRecordFile(runsDir, name);
    if (run) return run;
  }
  return null;
}

export function loadAllRunRecords(runsDir: string): Run[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readRunRecordFile(runsDir, name))
    .filter((run): run is Run => run !== null);
}

export function selectRunsForExport(input: {
  farmslotRoot: string;
  runIds?: string[];
  familyId?: string;
  positionalRunId?: string;
}): Run[] {
  const runsDir = resolveRunsDir(input.farmslotRoot);
  const all = loadAllRunRecords(runsDir);
  if (input.familyId) {
    const familyRuns = all.filter((run) => run.familyId === input.familyId);
    if (familyRuns.length === 0) {
      throw new Error(`No runs found for familyId ${input.familyId}`);
    }
    return familyRuns;
  }
  const requested = [
    ...(input.positionalRunId ? [input.positionalRunId] : []),
    ...(input.runIds ?? []),
  ];
  if (requested.length === 0) {
    throw new Error('Provide a run id, --run-id, or --family-id to export');
  }
  const selected: Run[] = [];
  for (const runId of requested) {
    const run =
      all.find((candidate) => candidate.id === runId) ??
      all.find((candidate) => candidate.id.startsWith(runId)) ??
      loadRunRecord(runsDir, runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (!selected.some((candidate) => candidate.id === run.id)) selected.push(run);
  }
  return selected;
}
