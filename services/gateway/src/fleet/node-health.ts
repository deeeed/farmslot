// node-health.ts — In-memory machine health state, local collection, headroom computation

import { execSync } from 'node:child_process';
import os from 'node:os';

import type { Headroom, MachineHealth, NodeSystemMetrics } from '@farmslot/protocol';

import { getCachedFleet } from './state.js';

const healthMap = new Map<string, MachineHealth>();
let localCollectionTimer: ReturnType<typeof setInterval> | null = null;
let prevCpuTimes: { idle: number; total: number } | null = null;

// ─── Headroom computation ───

export function computeHeadroom(cpu: number, mem: number, disk: number): Headroom {
  if (cpu > 90 || mem > 90 || disk > 95) return 'red';
  if (cpu > 70 || mem > 80 || disk > 85) return 'yellow';
  return 'green';
}

// ─── Update from agent push ───

export function updateMachineMetrics(machine: string, metrics: NodeSystemMetrics): void {
  const existing = healthMap.get(machine);
  const capacity = existing?.capacity ?? computeCapacity(machine);
  healthMap.set(machine, {
    machine,
    online: true,
    system: metrics,
    capacity,
    headroom: computeHeadroom(metrics.cpuPercent, metrics.memoryPercent, metrics.diskPercent),
  });
}

// ─── Mark machine offline ───

export function markMachineOffline(machine: string): void {
  const existing = healthMap.get(machine);
  if (existing) {
    existing.online = false;
    existing.headroom = 'red';
  } else {
    healthMap.set(machine, { machine, online: false, headroom: 'red' });
  }
}

// ─── Mark machine online (agent connected) ───

export function markMachineOnline(machine: string): void {
  const existing = healthMap.get(machine);
  if (existing) {
    existing.online = true;
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
  return {
    cpuPercent: getLocalCpuPercent(),
    memoryPercent: Math.round((usedMem / totalMem) * 100),
    memoryUsedGb: Math.round((usedMem / 1073741824) * 10) / 10,
    memoryTotalGb: Math.round((totalMem / 1073741824) * 10) / 10,
    diskPercent: getLocalDiskPercent(),
    loadAvg1: Math.round(loadAvg1 * 100) / 100,
    loadAvg5: Math.round(loadAvg5 * 100) / 100,
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
