// node-health.ts — In-memory machine health state, local collection, headroom computation

import os from 'node:os';

import {
  DEFAULT_PRESSURE_STALE_AFTER_MS,
  type Headroom,
  type MachineHealth,
  type NodeMetricsSample,
  type NodePressureHistoryFreshness,
  type NodePressureHistorySample,
  type NodePressureRatios,
  type NodeProcessInventory,
  type NodeProcessSamplerHealth,
  type NodeSystemMetrics,
  reattachHostLoad,
  type RecipeRuntimeCapabilityDeclaration,
  type SlotStatus,
} from '@farmslot/protocol';
import {
  canonicalResourceJson,
  type ResourceKey,
  resourceKeyId,
} from '@farmslot/protocol/client-cache';
import { collectTcpMetrics, formatTcpSnapshotDetail } from '@farmslot/protocol/node/tcp-metrics';

import { reportGatewayWarning } from '../chat/copilot-observer.js';
import { execFileArgv } from '../core/exec.js';
import { entityVersionHash } from '../resources/entity-version-hash.js';
import { type EntitySnapshot, resourceRevisions } from '../resources/revisions.js';

import { loadPressureHistory, savePressureHistory } from './pressure-history-store.js';
import { getCachedFleet } from './state.js';

const healthMap = new Map<string, MachineHealth>();
/** Machine entities for entity sync: the version and size of each sample, set when it is published. */
const machineEntities = new Map<string, { version: string; bytes: number }>();
const pressureHistory = new Map<string, NodePressureHistorySample[]>();
const processInventoryMap = new Map<string, NodeProcessInventory>();
const processSamplerHealthMap = new Map<string, NodeProcessSamplerHealth>();
const observationFingerprints = new Map<string, string>();
/** Machines that have delivered a live sample since this gateway booted.
 * Absent = the ring (if any) was rehydrated from the persisted store. */
const liveSampleSinceBoot = new Set<string>();
export const NODE_PRESSURE_HISTORY_LIMIT = 120;
const PRESSURE_HISTORY_PERSIST_DEBOUNCE_MS = 5_000;
const PRESSURE_SAMPLE_FUTURE_SKEW_MS = 30_000;
let pressurePersistTimer: ReturnType<typeof setTimeout> | null = null;
let localCollectionTimer: ReturnType<typeof setInterval> | null = null;
let prevCpuTimes: { idle: number; total: number } | null = null;

function publishMachineObservation(machine: string): void {
  const fingerprint = canonicalResourceJson({
    health: healthMap.get(machine),
    pressure: pressureHistory.get(machine),
    processInventory: processInventoryMap.get(machine),
    samplerHealth: processSamplerHealthMap.get(machine),
    live: liveSampleSinceBoot.has(machine),
  });
  if (observationFingerprints.get(machine) === fingerprint) return;
  observationFingerprints.set(machine, fingerprint);
  // The pushed machine entity (full MachineHealth) is versioned here, once per sample.
  const health = healthMap.get(machine);
  if (health)
    machineEntities.set(machine, {
      version: entityVersionHash(health),
      bytes: Buffer.byteLength(JSON.stringify(health)),
    });
  else machineEntities.delete(machine);
  const keys = new Map<string, ResourceKey>();
  const add = (key: ResourceKey) => keys.set(resourceKeyId(key), key);
  add({ family: 'node', nodeId: machine });
  add({ family: 'pressure', nodeId: machine });
  // Full fleet reads embed host load; slot entities do not, so no slot key advances.
  add({ family: 'slots', scope: 'farm' });
  add({ family: 'slots', scope: 'farm', nodeId: machine });
  for (const slot of getCachedFleet()?.slots ?? []) {
    if (slot.machine === machine && slot.project)
      add({ family: 'slots', scope: 'farm', project: slot.project });
  }
  for (const key of keys.values()) resourceRevisions.advance(key);
  const latest = pressureHistory.get(machine)?.at(-1);
  resourceRevisions.scheduleInvalidation(
    machine,
    { family: 'pressure', nodeId: machine },
    latest ? Date.parse(latest.collectedAt) + DEFAULT_PRESSURE_STALE_AFTER_MS + 1 : undefined,
  );
}

// ─── Headroom computation ───

export function computeHeadroom(cpu: number, mem: number, disk: number): Headroom {
  if (cpu > 90 || mem > 90 || disk > 95) return 'red';
  if (cpu > 70 || mem > 80 || disk > 85) return 'yellow';
  return 'green';
}

// ─── Update from agent push ───

export function updateMachineMetrics(machine: string, metrics: NodeMetricsSample): void {
  const existing = healthMap.get(machine);
  const computedCapacity = existing?.capacity ?? computeCapacity(machine);
  const capacity = {
    ...computedCapacity,
    cpuCores:
      typeof metrics.cpuCores === 'number' && metrics.cpuCores > 0
        ? metrics.cpuCores
        : computedCapacity.cpuCores,
  };
  updateProcessInventory(machine, metrics.processInventory);
  recordPressureSample(machine, metrics, capacity.cpuCores);
  const {
    processInventory: _processInventory,
    providerCliHealth,
    workerCliHealth,
    ...system
  } = metrics;
  const providers = providerCliHealth ?? existing?.providerCliHealth;
  const worker = workerCliHealth ?? existing?.workerCliHealth;
  const headroom = computeHeadroom(metrics.cpuPercent, metrics.memoryPercent, metrics.diskPercent);
  healthMap.set(machine, {
    machine,
    online: true,
    ...(existing?.capabilities ? { capabilities: existing.capabilities } : {}),
    system,
    providerCliHealth: providers,
    workerCliHealth: worker,
    capacity,
    headroom:
      metrics.tcp?.severity === 'critical' ||
      worker?.ok === false ||
      providers?.some(
        (health) => !health.ok && (health.status !== 'probe-timeout' || health.confirmedMismatch),
      )
        ? 'red'
        : headroom === 'green' &&
            (metrics.tcp?.severity === 'warning' ||
              metrics.tcp?.severity === 'unknown' ||
              providers?.some((health) => health.status === 'probe-timeout'))
          ? 'yellow'
          : headroom,
  });
  publishMachineObservation(machine);
  const tcp = metrics.tcp;
  if (tcp && tcp.severity !== 'ok' && tcp.severity !== existing?.system?.tcp?.severity) {
    const detail = tcp.severity === 'unknown' ? tcp.error : formatTcpSnapshotDetail(tcp);
    reportGatewayWarning(
      'node.tcp-pressure',
      `Node ${machine} TCP ${tcp.severity}: ${detail}`,
      tcp.severity === 'critical' ? 'error' : 'warn',
    );
  }
}

function updateProcessInventory(machine: string, incoming: NodeProcessInventory | undefined): void {
  if (!incoming) return;
  processSamplerHealthMap.set(machine, incoming.health);
  const current = processInventoryMap.get(machine);
  if (
    current &&
    incoming.generation === current.generation &&
    incoming.sampleId <= current.sampleId
  ) {
    return;
  }
  if (incoming.failed || (incoming.processes.length === 0 && incoming.health.lastError)) return;
  processInventoryMap.set(machine, incoming);
}

function normalizedPressure(metrics: NodeSystemMetrics, cpuCores: number): NodePressureRatios {
  if (metrics.pressure) return metrics.pressure;
  const rounded = (value: number) => Math.round(value * 1_000) / 1_000;
  return {
    cpu: rounded(metrics.cpuPercent / 100),
    memory: rounded(metrics.memoryPercent / 100),
    disk: rounded(metrics.diskPercent / 100),
    ...(cpuCores > 0
      ? {
          load1: rounded(metrics.loadAvg1 / cpuCores),
          load5: rounded(metrics.loadAvg5 / cpuCores),
        }
      : {}),
  };
}

function isNormalizedPressure(value: NodePressureRatios): boolean {
  const boundedRatios = [value.cpu, value.memory, value.disk];
  const loadRatios = [value.load1, value.load5];
  return (
    boundedRatios.every((ratio) => Number.isFinite(ratio) && ratio >= 0 && ratio <= 1) &&
    loadRatios.every((ratio) => ratio === undefined || (Number.isFinite(ratio) && ratio >= 0))
  );
}

/** Reject malformed live samples before they can mark a rehydrated ring as
 * live. The admission policy also validates its input, but the boot marker is
 * set here, so validation must happen at the storage boundary too. */
function isRecordablePressureSample(
  metrics: NodeMetricsSample,
  pressure: NodePressureRatios,
  collectedAtMs: number,
): boolean {
  return (
    collectedAtMs <= Date.now() + PRESSURE_SAMPLE_FUTURE_SKEW_MS &&
    [metrics.cpuPercent, metrics.memoryPercent, metrics.diskPercent].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 100,
    ) &&
    [metrics.loadAvg1, metrics.loadAvg5].every((value) => Number.isFinite(value) && value >= 0) &&
    isNormalizedPressure(pressure)
  );
}

function recordPressureSample(machine: string, metrics: NodeMetricsSample, cpuCores: number): void {
  const samples = pressureHistory.get(machine) ?? [];
  const latest = samples.at(-1);
  const collectedAtMs = Date.parse(metrics.collectedAt);
  if (!Number.isFinite(collectedAtMs)) return;
  if (latest && collectedAtMs <= Date.parse(latest.collectedAt)) return;
  const pressure = normalizedPressure(metrics, cpuCores);
  if (!isRecordablePressureSample(metrics, pressure, collectedAtMs)) return;
  const inventory = metrics.processInventory;
  samples.push({
    ...(inventory ? { generation: inventory.generation, sampleId: inventory.sampleId } : {}),
    collectedAt: metrics.collectedAt,
    pressure,
    cpuPercent: metrics.cpuPercent,
    memoryPercent: metrics.memoryPercent,
    diskPercent: metrics.diskPercent,
    loadAvg1: metrics.loadAvg1,
    loadAvg5: metrics.loadAvg5,
  });
  if (samples.length > NODE_PRESSURE_HISTORY_LIMIT) {
    samples.splice(0, samples.length - NODE_PRESSURE_HISTORY_LIMIT);
  }
  pressureHistory.set(machine, samples);
  liveSampleSinceBoot.add(machine);
  schedulePressureHistoryPersist();
}

// ─── Persisted pressure history (MANUAL-000109) ───

/**
 * Rehydrate the bounded normalized ring from the persisted store. Called once
 * at startup BEFORE ordinary fleet/resource recovery so Command Center and
 * dispatch admission warm-start immediately instead of waiting for three live
 * 30s samples. Live samples always win: a machine that already produced one
 * this boot keeps its live ring.
 */
export function rehydratePressureHistory(): void {
  const loaded = loadPressureHistory(NODE_PRESSURE_HISTORY_LIMIT);
  if (loaded.quarantinedReason) {
    console.error(`[node-health] pressure history store quarantined: ${loaded.quarantinedReason}`);
  }
  let restored = 0;
  for (const [machine, samples] of loaded.machines) {
    if (liveSampleSinceBoot.has(machine)) continue;
    pressureHistory.set(machine, samples);
    publishMachineObservation(machine);
    restored += 1;
  }
  if (restored > 0) {
    console.log(`[node-health] rehydrated pressure history for ${restored} machine(s)`);
  }
}

/** Coalesce per-machine sample pushes into one atomic write every few seconds. */
function schedulePressureHistoryPersist(): void {
  if (pressurePersistTimer) return;
  pressurePersistTimer = setTimeout(() => {
    pressurePersistTimer = null;
    try {
      savePressureHistory(pressureHistory, NODE_PRESSURE_HISTORY_LIMIT);
    } catch (error) {
      // A failed persist only costs warm-start after the NEXT restart; the
      // live ring is intact. Log loudly so a permanently broken store path is
      // visible instead of silently discovered at the next boot.
      console.error(`[node-health] pressure history persist failed: ${(error as Error).message}`);
    }
  }, PRESSURE_HISTORY_PERSIST_DEBOUNCE_MS);
  pressurePersistTimer.unref?.();
}

/** Freshness of a machine's ring: restored-vs-live plus explicit staleness. */
export function getMachinePressureHistoryFreshness(
  machine: string,
  now = Date.now(),
): NodePressureHistoryFreshness {
  const latest = pressureHistory.get(machine)?.at(-1);
  const latestSampleAt = latest?.collectedAt ?? null;
  const ageMs = latestSampleAt ? Math.max(0, now - Date.parse(latestSampleAt)) : null;
  return {
    source: !latest ? 'none' : liveSampleSinceBoot.has(machine) ? 'live' : 'restored',
    latestSampleAt,
    ageMs,
    stale: ageMs === null || ageMs > DEFAULT_PRESSURE_STALE_AFTER_MS,
  };
}

/** Machines with any ring content, including rehydrated machines whose node
 * has not reconnected yet this boot. */
export function listPressureHistoryMachines(): string[] {
  return [...new Set([...pressureHistory.keys(), ...healthMap.keys()])].sort();
}

/** Test hook: reset in-memory pressure state (ring, live markers, timers). */
export function resetPressureHistoryForTest(): void {
  pressureHistory.clear();
  liveSampleSinceBoot.clear();
  if (pressurePersistTimer) {
    clearTimeout(pressurePersistTimer);
    pressurePersistTimer = null;
  }
}

// ─── Mark machine offline ───

export function markMachineOffline(machine: string): void {
  // A process census is unsafe once the node disconnects; bounded gauge history
  // remains useful for reconnect diagnosis and contains no PID/path data.
  processInventoryMap.delete(machine);
  processSamplerHealthMap.delete(machine);
  const existing = healthMap.get(machine);
  if (existing) {
    existing.online = false;
    existing.headroom = 'red';
  } else {
    healthMap.set(machine, { machine, online: false, headroom: 'red' });
  }
  publishMachineObservation(machine);
}

// ─── Mark machine online (agent connected) ───

export function markMachineOnline(
  machine: string,
  capabilities?: RecipeRuntimeCapabilityDeclaration[],
): void {
  const existing = healthMap.get(machine);
  if (existing) {
    existing.online = true;
    if (capabilities) existing.capabilities = capabilities;
  } else {
    healthMap.set(machine, {
      machine,
      online: true,
      ...(capabilities ? { capabilities } : {}),
      headroom: 'green',
    });
  }
  publishMachineObservation(machine);
}

// ─── Local metrics collection (for runner-local — no agent needed) ───

function getCpuTimes(): { idle: number; total: number } {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
  }
  return { idle, total };
}

function getLocalCpuPercent(): number {
  const current = getCpuTimes();
  if (!prevCpuTimes) {
    prevCpuTimes = current;
    return 0;
  }
  const idleDelta = current.idle - prevCpuTimes.idle;
  const totalDelta = current.total - prevCpuTimes.total;
  prevCpuTimes = current;
  if (totalDelta === 0) return 0;
  return Math.round((1 - idleDelta / totalDelta) * 100);
}

// These probes run on the gateway's 30 s timer, so they use the async exec wrapper: a blocking
// call here stalls every stream and RPC. A probe that exits non-zero leaves its metric at the
// documented fallback (0, unknown thermal, or os.freemem); the next tick tries again.
async function getLocalDiskPercent(): Promise<number> {
  const { stdout, exitCode } = await execFileArgv(['df', '-k', '/'], { timeout: 5000 });
  if (exitCode !== 0) return 0;
  const capField = stdout
    .trim()
    .split('\n')
    .at(-1)
    ?.split(/\s+/)
    .find((p) => p.endsWith('%'));
  return capField ? parseInt(capField, 10) : 0;
}

type LocalThermal = NodeSystemMetrics['thermalPressure'];

async function getLocalThermal(): Promise<LocalThermal> {
  if (process.platform !== 'darwin') return undefined;
  const { stdout, exitCode } = await execFileArgv(['pmset', '-g', 'therm'], { timeout: 5000 });
  if (exitCode !== 0) return undefined;
  const match = stdout.match(/CPU_Speed_Limit\s*=\s*(\d+)/);
  if (!match) return 'nominal';
  const limit = parseInt(match[1], 10);
  if (limit >= 100) return 'nominal';
  if (limit >= 75) return 'fair';
  if (limit >= 50) return 'serious';
  return 'critical';
}

interface LocalMemoryUsage {
  usedBytes: number;
  totalBytes: number;
}

async function getLocalMemoryUsage(): Promise<LocalMemoryUsage> {
  const totalBytes = os.totalmem();
  if (process.platform === 'darwin') {
    const [sysctl, vmstat] = await Promise.all([
      execFileArgv(['/usr/sbin/sysctl', '-n', 'vm.page_pageable_internal_count', 'hw.pagesize'], {
        timeout: 5000,
      }),
      execFileArgv(['vm_stat'], { timeout: 5000 }),
    ]);
    if (sysctl.exitCode === 0 && vmstat.exitCode === 0) {
      const [internal, pageSize] = sysctl.stdout
        .trim()
        .split('\n')
        .map((line) => parseInt(line, 10));
      const wired = parseInt(vmstat.stdout.match(/Pages wired down:\s+(\d+)/)?.[1] ?? '0', 10);
      const compressor = parseInt(
        vmstat.stdout.match(/Pages occupied by compressor:\s+(\d+)/)?.[1] ?? '0',
        10,
      );
      if (Number.isFinite(internal) && Number.isFinite(pageSize))
        return { usedBytes: (internal + wired + compressor) * pageSize, totalBytes };
    }
  }
  return { usedBytes: totalBytes - os.freemem(), totalBytes };
}

export async function collectLocalMetrics(): Promise<NodeSystemMetrics> {
  const [{ usedBytes: usedMem, totalBytes: totalMem }, diskPercent, thermalPressure, tcp] =
    await Promise.all([
      getLocalMemoryUsage(),
      getLocalDiskPercent(),
      getLocalThermal(),
      collectTcpMetrics(),
    ]);
  const [loadAvg1, loadAvg5] = os.loadavg();
  const cpuCores = os.cpus().length;
  const cpuPercent = getLocalCpuPercent();
  const memoryPercent = Math.round((usedMem / totalMem) * 100);
  const rounded = (value: number) => Math.round(value * 1_000) / 1_000;
  return {
    cpuPercent,
    memoryPercent,
    memoryUsedGb: Math.round((usedMem / 1073741824) * 10) / 10,
    memoryTotalGb: Math.round((totalMem / 1073741824) * 10) / 10,
    diskPercent,
    loadAvg1: Math.round(loadAvg1 * 100) / 100,
    loadAvg5: Math.round(loadAvg5 * 100) / 100,
    cpuCores,
    pressure: {
      cpu: rounded(cpuPercent / 100),
      memory: rounded(memoryPercent / 100),
      disk: rounded(diskPercent / 100),
      load1: rounded(loadAvg1 / Math.max(1, cpuCores)),
      load5: rounded(loadAvg5 / Math.max(1, cpuCores)),
    },
    thermalPressure,
    tcp,
    collectedAt: new Date().toISOString(),
  };
}

// ─── Capacity helper ───

function computeCapacity(machine: string): {
  maxSlots: number;
  activeSlots: number;
  cpuCores: number;
} {
  const fleet = getCachedFleet();
  const machineSlots = fleet?.slots.filter((s) => s.machine === machine) ?? [];
  const activeSlots = machineSlots.filter((s) => s.lifecycle === 'busy').length;
  return {
    maxSlots: machineSlots.length,
    activeSlots,
    cpuCores: machine === os.hostname() ? os.cpus().length : 0,
  };
}

// ─── Start local collection on gateway host ───

let onLocalUpdate: ((machine: string) => void) | null = null;

export function startLocalCollection(
  localMachine: string,
  intervalMs = 30_000,
  onUpdate?: (machine: string) => void,
): void {
  if (localCollectionTimer) return;
  onLocalUpdate = onUpdate ?? null;
  // Take initial CPU snapshot
  getLocalCpuPercent();
  let collecting = false;
  localCollectionTimer = setInterval(() => {
    // A slow probe must not stack a second collection behind it.
    if (collecting) return;
    collecting = true;
    void collectLocalMetrics()
      .then(
        (metrics) => {
          updateMachineMetrics(localMachine, metrics);
          if (onLocalUpdate) onLocalUpdate(localMachine);
        },
        (error: unknown) => {
          // Only collection is recovered: one missed sample keeps the previous metrics and the
          // next tick collects again. Publication errors above are not caught here.
          console.warn(
            `[node-health] local metrics collection failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      )
      .finally(() => {
        collecting = false;
      });
  }, intervalMs);
  localCollectionTimer.unref();
  // Mark online immediately
  markMachineOnline(localMachine);
}

export function stopLocalCollection(): void {
  if (localCollectionTimer) {
    clearInterval(localCollectionTimer);
    localCollectionTimer = null;
  }
}

// ─── Query ───

export function getMachineHealth(machine: string): MachineHealth | undefined {
  return healthMap.get(machine);
}

/** The published machine entity behind a node key; undefined until its first sample. */
function machineEntityProvider(key: ResourceKey): EntitySnapshot | undefined {
  if (key.family !== 'node' || !('nodeId' in key)) return undefined;
  const entity = healthMap.get(key.nodeId);
  const stored = machineEntities.get(key.nodeId);
  return entity && stored ? { family: 'node', entity, ...stored } : undefined;
}
resourceRevisions.setEntityProvider('node', machineEntityProvider);

export function getAllMachineHealth(): MachineHealth[] {
  return Array.from(healthMap.values());
}

export function getMachinePressureHistory(machine: string): NodePressureHistorySample[] {
  return pressureHistory.get(machine)?.map((sample) => structuredClone(sample)) ?? [];
}

export function getMachineProcessInventory(machine: string): NodeProcessInventory | undefined {
  const inventory = processInventoryMap.get(machine);
  if (!inventory) return undefined;
  return structuredClone({
    ...inventory,
    health: processSamplerHealthMap.get(machine) ?? inventory.health,
  });
}

export function getMachineProcessSamplerHealth(
  machine: string,
): NodeProcessSamplerHealth | undefined {
  const health = processSamplerHealthMap.get(machine);
  return health ? structuredClone(health) : undefined;
}

// ─── Enrich fleet status with hostLoad per slot ───

/**
 * Enrich slots with current machine hostLoad, mutating the array in place.
 * Delegates to protocol's reattachHostLoad so the gateway full read and the
 * client entity-sync path share one implementation. When machine health is
 * absent (e.g. a remote slot) hostLoad is left unset.
 */
export function enrichSlotHostLoad(slots: SlotStatus[]): void {
  const machines = getAllMachineHealth();
  // Strip any existing hostLoad (previous enrichment or stale data), then
  // re-attach from the current in-process health map via the protocol function.
  const entities = slots.map(({ hostLoad: _, ...rest }) => rest);
  const enriched = reattachHostLoad(entities, machines);
  for (let i = 0; i < slots.length; i++) {
    slots[i] = enriched[i] ?? slots[i];
  }
}
