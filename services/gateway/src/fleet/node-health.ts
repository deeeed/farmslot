// node-health.ts — In-memory machine health state, local collection, headroom computation

import { execSync } from 'node:child_process';
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
  type RecipeRuntimeCapabilityDeclaration,
} from '@farmslot/protocol';

import { loadPressureHistory, savePressureHistory } from './pressure-history-store.js';
import { getCachedFleet } from './state.js';

const healthMap = new Map<string, MachineHealth>();
const pressureHistory = new Map<string, NodePressureHistorySample[]>();
const processInventoryMap = new Map<string, NodeProcessInventory>();
const processSamplerHealthMap = new Map<string, NodeProcessSamplerHealth>();
/** Machines that have delivered a live sample since this gateway booted.
 * Absent = the ring (if any) was rehydrated from the persisted store. */
const liveSampleSinceBoot = new Set<string>();
export const NODE_PRESSURE_HISTORY_LIMIT = 120;
const PRESSURE_HISTORY_PERSIST_DEBOUNCE_MS = 5_000;
const PRESSURE_SAMPLE_FUTURE_SKEW_MS = 30_000;
let pressurePersistTimer: ReturnType<typeof setTimeout> | null = null;
let localCollectionTimer: ReturnType<typeof setInterval> | null = null;
let prevCpuTimes: { idle: number; total: number } | null = null;

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
  const { processInventory: _processInventory, ...system } = metrics;
  healthMap.set(machine, {
    machine,
    online: true,
    ...(existing?.capabilities ? { capabilities: existing.capabilities } : {}),
    system,
    capacity,
    headroom: computeHeadroom(metrics.cpuPercent, metrics.memoryPercent, metrics.diskPercent),
  });
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

function getLocalDiskPercent(): number {
  try {
    const output = execSync('df -k / | tail -1', { timeout: 5000, encoding: 'utf-8' });
    const capField = output
      .trim()
      .split(/\s+/)
      .find((p) => p.endsWith('%'));
    return capField ? parseInt(capField, 10) : 0;
  } catch {
    return 0;
  }
}

function getLocalThermal(): 'nominal' | 'fair' | 'serious' | 'critical' | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const output = execSync('pmset -g therm 2>/dev/null', { timeout: 5000, encoding: 'utf-8' });
    const match = output.match(/CPU_Speed_Limit\s*=\s*(\d+)/);
    if (match) {
      const limit = parseInt(match[1], 10);
      if (limit >= 100) return 'nominal';
      if (limit >= 75) return 'fair';
      if (limit >= 50) return 'serious';
      return 'critical';
    }
    return 'nominal';
  } catch {
    return undefined;
  }
}

function getLocalMemoryUsage(): { usedBytes: number; totalBytes: number } {
  const totalBytes = os.totalmem();
  if (process.platform === 'darwin') {
    try {
      const sysctl = execSync('/usr/sbin/sysctl -n vm.page_pageable_internal_count hw.pagesize', {
        timeout: 5000,
        encoding: 'utf-8',
      })
        .trim()
        .split('\n');
      const internal = parseInt(sysctl[0], 10);
      const pageSize = parseInt(sysctl[1], 10);
      const vmstat = execSync('vm_stat', { timeout: 5000, encoding: 'utf-8' });
      const wired = parseInt(vmstat.match(/Pages wired down:\s+(\d+)/)?.[1] ?? '0', 10);
      const compressor = parseInt(
        vmstat.match(/Pages occupied by compressor:\s+(\d+)/)?.[1] ?? '0',
        10,
      );
      return { usedBytes: (internal + wired + compressor) * pageSize, totalBytes };
    } catch {
      /* fallback */
    }
  }
  return { usedBytes: totalBytes - os.freemem(), totalBytes };
}

export function collectLocalMetrics(): NodeSystemMetrics {
  const { usedBytes: usedMem, totalBytes: totalMem } = getLocalMemoryUsage();
  const [loadAvg1, loadAvg5] = os.loadavg();
  const cpuCores = os.cpus().length;
  const cpuPercent = getLocalCpuPercent();
  const memoryPercent = Math.round((usedMem / totalMem) * 100);
  const diskPercent = getLocalDiskPercent();
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
    thermalPressure: getLocalThermal(),
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
  localCollectionTimer = setInterval(() => {
    const metrics = collectLocalMetrics();
    updateMachineMetrics(localMachine, metrics);
    if (onLocalUpdate) onLocalUpdate(localMachine);
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

export function enrichSlotHostLoad(
  slots: Array<{
    machine: string;
    hostLoad?: { cpuPercent: number; memoryPercent: number; diskPercent: number; headroom: string };
  }>,
): void {
  for (const slot of slots) {
    const health = healthMap.get(slot.machine);
    if (health?.system) {
      slot.hostLoad = {
        cpuPercent: health.system.cpuPercent,
        memoryPercent: health.system.memoryPercent,
        diskPercent: health.system.diskPercent,
        headroom: health.headroom,
      };
    }
  }
}
