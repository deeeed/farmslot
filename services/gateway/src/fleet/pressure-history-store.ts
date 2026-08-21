// pressure-history-store.ts — persisted bounded pressure history (MANUAL-000109).
//
// The gateway keeps the normalized node-pressure sample ring in memory; a
// restart used to blank it, so Command Center charts and sustained-pressure
// admission had to wait for three live 30s samples. This store persists ONLY
// normalized gauge samples plus timestamps/generation/sampleId — never process
// paths, PIDs, or command lines — under the resolved FARMSLOT_HOME, and
// rehydrates the ring before ordinary fleet/resource recovery runs.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { NodePressureHistorySample } from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

export const PRESSURE_HISTORY_STORE_VERSION = 1;

export interface PressureHistoryStoreFile {
  version: typeof PRESSURE_HISTORY_STORE_VERSION;
  savedAt: string;
  machines: Record<string, NodePressureHistorySample[]>;
}

export interface PressureHistoryLoadResult {
  machines: Map<string, NodePressureHistorySample[]>;
  /** Set when the file existed but could not be trusted and was set aside. */
  quarantinedReason?: string;
}

function storePath(): string {
  // Resolve lazily — FARMSLOT_HOME can be set after module import.
  return path.join(farmslotHome(), 'state', 'pressure-history.json');
}

const SAMPLE_NUMBER_FIELDS = [
  'cpuPercent',
  'memoryPercent',
  'diskPercent',
  'loadAvg1',
  'loadAvg5',
] as const;

/** Restored samples may lead the local clock only by this much. Anything
 * further in the future is malformed data; the in-memory recorder skips
 * samples older than its newest entry, so one future-dated restored sample
 * would otherwise suppress every live update after restart. */
const FUTURE_RESTORED_SAMPLE_SKEW_MS = 60_000;
const MAX_GENERATION_LENGTH = 200;

function boundedNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function ratioInRange(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Strict per-sample validation: normalized gauges only (ratios in [0,1],
 * nonnegative loads/percents, integer nonnegative sampleId, bounded
 * generation string), parseable non-future timestamp. Any extra shape is
 * rebuilt field-by-field so a hand-edited or corrupt file can never smuggle
 * process detail back into memory. */
function normalizeSample(raw: unknown, now = Date.now()): NodePressureHistorySample | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const collectedAt = candidate.collectedAt;
  if (typeof collectedAt !== 'string') return null;
  const collectedAtMs = Date.parse(collectedAt);
  if (!Number.isFinite(collectedAtMs) || collectedAtMs > now + FUTURE_RESTORED_SAMPLE_SKEW_MS) {
    return null;
  }
  const pressure = candidate.pressure;
  if (typeof pressure !== 'object' || pressure === null) return null;
  const ratios = pressure as Record<string, unknown>;
  for (const key of ['cpu', 'memory', 'disk'] as const) {
    if (!ratioInRange(ratios[key])) return null;
  }
  for (const key of ['load1', 'load5'] as const) {
    if (ratios[key] !== undefined && !boundedNonNegative(ratios[key])) return null;
  }
  for (const key of SAMPLE_NUMBER_FIELDS) {
    if (!boundedNonNegative(candidate[key])) return null;
  }
  if (
    candidate.sampleId !== undefined &&
    (typeof candidate.sampleId !== 'number' ||
      !Number.isInteger(candidate.sampleId) ||
      candidate.sampleId < 0)
  ) {
    return null;
  }
  if (
    candidate.generation !== undefined &&
    (typeof candidate.generation !== 'string' ||
      candidate.generation.length === 0 ||
      candidate.generation.length > MAX_GENERATION_LENGTH)
  ) {
    return null;
  }
  return {
    ...(typeof candidate.generation === 'string' ? { generation: candidate.generation } : {}),
    ...(typeof candidate.sampleId === 'number' ? { sampleId: candidate.sampleId } : {}),
    collectedAt,
    pressure: {
      cpu: ratios.cpu as number,
      memory: ratios.memory as number,
      disk: ratios.disk as number,
      ...(typeof ratios.load1 === 'number' ? { load1: ratios.load1 } : {}),
      ...(typeof ratios.load5 === 'number' ? { load5: ratios.load5 } : {}),
    },
    cpuPercent: candidate.cpuPercent as number,
    memoryPercent: candidate.memoryPercent as number,
    diskPercent: candidate.diskPercent as number,
    loadAvg1: candidate.loadAvg1 as number,
    loadAvg5: candidate.loadAvg5 as number,
  };
}

/** Atomic persist: write a sibling temp file, then rename over the store. */
export function savePressureHistory(
  machines: ReadonlyMap<string, NodePressureHistorySample[]>,
  sampleLimit: number,
): void {
  const target = storePath();
  mkdirSync(path.dirname(target), { recursive: true });
  const file: PressureHistoryStoreFile = {
    version: PRESSURE_HISTORY_STORE_VERSION,
    savedAt: new Date().toISOString(),
    machines: Object.fromEntries(
      [...machines]
        .map(
          ([machine, samples]) =>
            [
              machine,
              // Field-by-field rebuild on the way OUT too: the on-disk payload can
              // only ever contain normalized gauges + timestamps/generation/id.
              samples
                .map((rawSample) => normalizeSample(rawSample))
                .filter((sample): sample is NodePressureHistorySample => sample !== null)
                .slice(-sampleLimit),
            ] as const,
        )
        .filter(([, samples]) => (samples as NodePressureHistorySample[]).length > 0),
    ),
  };
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(file));
  renameSync(temp, target);
}

/**
 * Load and validate the persisted ring. An unreadable or wrong-version file is
 * quarantined (renamed aside) so one bad write can never wedge startup; bad
 * individual samples are dropped, and each machine's ring is re-bounded.
 */
export function loadPressureHistory(sampleLimit: number): PressureHistoryLoadResult {
  const target = storePath();
  if (!existsSync(target)) return { machines: new Map() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, 'utf-8'));
  } catch (error) {
    return {
      machines: new Map(),
      quarantinedReason: quarantine(target, `unparseable JSON: ${(error as Error).message}`),
    };
  }
  const file = parsed as Partial<PressureHistoryStoreFile> | null;
  if (
    typeof file !== 'object' ||
    file === null ||
    file.version !== PRESSURE_HISTORY_STORE_VERSION ||
    typeof file.machines !== 'object' ||
    file.machines === null
  ) {
    return {
      machines: new Map(),
      quarantinedReason: quarantine(target, `unsupported shape/version ${String(file?.version)}`),
    };
  }
  const machines = new Map<string, NodePressureHistorySample[]>();
  for (const [machine, rawSamples] of Object.entries(file.machines)) {
    if (!machine.trim() || machine.length > 100 || !Array.isArray(rawSamples)) continue;
    const samples = rawSamples
      .map((rawSample) => normalizeSample(rawSample))
      .filter((sample): sample is NodePressureHistorySample => sample !== null)
      .sort((a, b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt))
      .slice(-sampleLimit);
    if (samples.length > 0) machines.set(machine, samples);
  }
  return { machines };
}

function quarantine(target: string, reason: string): string {
  const aside = `${target}.quarantined-${Date.now()}`;
  try {
    renameSync(target, aside);
  } catch (error) {
    // The rename itself failing (permissions, races) must not block startup;
    // report both problems and continue with an empty ring.
    return `${reason}; quarantine rename also failed: ${(error as Error).message}`;
  }
  return `${reason}; file moved to ${aside}`;
}
