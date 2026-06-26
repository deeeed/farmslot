import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { farmslotRoot } from '../fleet/state.js';
import { shouldUseIsolatedRunsDir } from '../runs/store.js';

import type { RunnerObservabilityAgreementEntry } from './observability-agreement.js';

export interface ObservabilityAgreementAggregate {
  total: number;
  agreed: number;
  disagreed: number;
  hookUnavailable: number;
  disagreementReasons: Record<string, number>;
}

let _agreementDir: string | null = null;

function agreementLogDir(): string {
  if (_agreementDir) return _agreementDir;
  if (process.env.FARMSLOT_OBSERVABILITY_AGREEMENT_DIR) {
    _agreementDir = process.env.FARMSLOT_OBSERVABILITY_AGREEMENT_DIR;
  } else if (shouldUseIsolatedRunsDir(process.env, process.argv)) {
    _agreementDir = path.join(os.tmpdir(), `farmslot-test-obs-agreement-${process.pid}`);
  } else {
    _agreementDir = path.join(farmslotRoot, '.runs', 'observability-agreement');
  }
  return _agreementDir;
}

function dayFile(ts: number): string {
  const day = new Date(ts).toISOString().slice(0, 10);
  return path.join(agreementLogDir(), `agreement-${day}.ndjson`);
}

export async function appendRunnerObservabilityAgreement(
  entry: RunnerObservabilityAgreementEntry,
): Promise<void> {
  const dir = agreementLogDir();
  await mkdir(dir, { recursive: true });
  const payload = {
    kind: 'runner-observability-agreement',
    ...entry,
  };
  await appendFile(dayFile(entry.timestamp), `${JSON.stringify(payload)}\n`, 'utf-8');
}

export async function readAgreementEntriesSince(sinceMs: number): Promise<
  Array<RunnerObservabilityAgreementEntry & { kind: string }>
> {
  const dir = agreementLogDir();
  let files: string[] = [];
  try {
    files = (await readdir(dir))
      .filter((name) => name.startsWith('agreement-') && name.endsWith('.ndjson'))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const entries: Array<RunnerObservabilityAgreementEntry & { kind: string }> = [];
  for (const file of files) {
    const raw = await readFile(path.join(dir, file), 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as RunnerObservabilityAgreementEntry & {
          kind?: string;
          timestamp?: number;
        };
        if (typeof parsed.timestamp !== 'number' || parsed.timestamp < sinceMs) continue;
        entries.push({ kind: 'runner-observability-agreement', ...parsed });
      } catch {
        // skip malformed lines
      }
    }
  }
  return entries;
}

export function aggregateAgreementEntries(
  entries: readonly RunnerObservabilityAgreementEntry[],
): ObservabilityAgreementAggregate {
  const disagreementReasons: Record<string, number> = {};
  let agreed = 0;
  let disagreed = 0;
  let hookUnavailable = 0;
  for (const entry of entries) {
    if (entry.hookBusy == null) {
      hookUnavailable += 1;
      continue;
    }
    if (entry.agreed === true) agreed += 1;
    else if (entry.agreed === false) {
      disagreed += 1;
      const reason = entry.disagreementReason ?? 'unknown-mismatch';
      disagreementReasons[reason] = (disagreementReasons[reason] ?? 0) + 1;
    }
  }
  return {
    total: entries.length,
    agreed,
    disagreed,
    hookUnavailable,
    disagreementReasons,
  };
}