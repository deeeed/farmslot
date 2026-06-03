// eval-suite-cap-store.ts — Durable eval matrix concurrency caps

import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isTerminalRunStatus, type QueueItem } from '@farmslot/protocol';

import { farmslotRoot } from '../fleet/state.js';
import { getAllRuns } from '../runs/store.js';

const DEFAULT_EVAL_SUITE_CAP = 1;

interface EvalSuiteCapRecord {
  capGroupId: string;
  suiteId?: string;
  cap: number;
  updatedAt: string;
}

function shouldUseIsolatedEvalCapStore(env: NodeJS.ProcessEnv, argv: readonly string[]): boolean {
  if (env.FARMSLOT_TEST_TMP === '1' || env.NODE_TEST_CONTEXT) return true;
  return argv.some((arg) => /(?:^|[/\\])[^/\\]+\.test\.(?:ts|tsx|js|mjs|cjs)$/.test(arg));
}

function resolveEvalCapFile(): string {
  if (process.env.FARMSLOT_EVAL_SUITE_CAP_FILE) return process.env.FARMSLOT_EVAL_SUITE_CAP_FILE;
  if (shouldUseIsolatedEvalCapStore(process.env, process.argv)) {
    return path.join(os.tmpdir(), `farmslot-test-eval-suite-caps-${process.pid}.json`);
  }
  return path.join(farmslotRoot, '.eval-suite-caps.json');
}

const CAP_FILE = resolveEvalCapFile();
const caps = new Map<string, EvalSuiteCapRecord>();

function normalizeCapGroupId(capGroupId: string): string {
  const normalized = capGroupId.trim();
  if (!normalized) throw new Error('capGroupId is required');
  return normalized;
}

function normalizeCap(cap: number): number {
  if (!Number.isFinite(cap)) throw new Error('cap must be a finite number');
  return Math.max(1, Math.floor(cap));
}

async function persistEvalSuiteCaps(): Promise<void> {
  await writeFile(CAP_FILE, JSON.stringify([...caps.values()], null, 2), 'utf-8');
}

export async function loadEvalSuiteCaps(): Promise<void> {
  caps.clear();
  try {
    const raw = await readFile(CAP_FILE, 'utf-8');
    const records = JSON.parse(raw) as EvalSuiteCapRecord[];
    for (const record of records) {
      if (!record?.capGroupId) continue;
      caps.set(record.capGroupId, {
        capGroupId: record.capGroupId,
        suiteId: record.suiteId,
        cap: normalizeCap(record.cap),
        updatedAt: record.updatedAt ?? new Date().toISOString(),
      });
    }
    console.log(`[eval-cap] loaded ${caps.size} suite cap records`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(`[eval-cap] failed to load cap store: ${(err as Error).message}`);
    }
  }
}

export function getEvalSuiteCap(capGroupId: string): number {
  return caps.get(normalizeCapGroupId(capGroupId))?.cap ?? DEFAULT_EVAL_SUITE_CAP;
}

export async function setEvalSuiteCap(
  capGroupId: string,
  cap: number,
  suiteId?: string,
): Promise<void> {
  const normalizedCapGroupId = normalizeCapGroupId(capGroupId);
  caps.set(normalizedCapGroupId, {
    capGroupId: normalizedCapGroupId,
    suiteId: suiteId?.trim() || caps.get(normalizedCapGroupId)?.suiteId,
    cap: normalizeCap(cap),
    updatedAt: new Date().toISOString(),
  });
  await persistEvalSuiteCaps();
}

export function evalSuiteCapUsage(capGroupId: string, queuedItems: readonly QueueItem[]) {
  const normalizedCapGroupId = normalizeCapGroupId(capGroupId);
  const active = getAllRuns().filter(
    (run) =>
      run.engineState?.evalExperiment?.capGroupId === normalizedCapGroupId &&
      !isTerminalRunStatus(run.status),
  ).length;
  const dispatching = queuedItems.filter(
    (item) => item.status === 'dispatching' && item.evalCell?.capGroupId === normalizedCapGroupId,
  ).length;
  const queued = queuedItems.filter(
    (item) => item.status === 'queued' && item.evalCell?.capGroupId === normalizedCapGroupId,
  ).length;
  const cap = getEvalSuiteCap(normalizedCapGroupId);
  // Older queue files may predate suiteId persistence; usage remains valid
  // with an undefined suiteId because capGroupId is the scheduling key.
  const suiteId =
    caps.get(normalizedCapGroupId)?.suiteId ??
    queuedItems.find((item) => item.evalCell?.capGroupId === normalizedCapGroupId)?.evalCell
      ?.suiteId;
  return {
    capGroupId: normalizedCapGroupId,
    suiteId,
    cap,
    active,
    dispatching,
    queued,
    total: active + dispatching + queued,
  };
}
