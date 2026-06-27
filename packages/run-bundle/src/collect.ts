import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import type { Run } from '@farmslot/protocol';

import { resolveRunsDir } from './paths.js';

export function loadRunRecord(runsDir: string, runId: string): Run | null {
  const exact = path.join(runsDir, `${runId}.json`);
  if (existsSync(exact)) {
    return JSON.parse(readFileSync(exact, 'utf-8')) as Run;
  }
  const files = readdirSync(runsDir).filter((name) => name.endsWith('.json'));
  const match = files.find((name) => name.replace(/\.json$/, '').startsWith(runId));
  if (!match) return null;
  return JSON.parse(readFileSync(path.join(runsDir, match), 'utf-8')) as Run;
}

export function loadAllRunRecords(runsDir: string): Run[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(path.join(runsDir, name), 'utf-8')) as Run);
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