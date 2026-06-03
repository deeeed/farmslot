// system-metrics.ts — Collect host-level CPU, memory, disk, load, thermal metrics

import { execSync } from 'node:child_process';
import os from 'node:os';

export interface SystemMetrics {
  cpuPercent: number;
  memoryPercent: number;
  memoryUsedGb: number;
  memoryTotalGb: number;
  diskPercent: number;
  loadAvg1: number;
  loadAvg5: number;
  thermalPressure?: 'nominal' | 'fair' | 'serious' | 'critical';
  collectedAt: string;
}

// Previous CPU snapshot for delta computation
let prevCpuTimes: { idle: number; total: number } | null = null;

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

function getCpuPercent(): number {
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

function getDiskPercent(): number {
  try {
    const output = execSync('df -k / | tail -1', { timeout: 5000, encoding: 'utf-8' });
    const parts = output.trim().split(/\s+/);
    // df output: Filesystem 1K-blocks Used Available Use% Mounted
    // macOS: Filesystem 1024-blocks Used Available Capacity ...
    const capField = parts.find((p) => p.endsWith('%'));
    if (capField) return parseInt(capField, 10);
    return 0;
  } catch {
    return 0;
  }
}

function getThermalPressure(): 'nominal' | 'fair' | 'serious' | 'critical' | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const output = execSync('pmset -g therm 2>/dev/null', { timeout: 5000, encoding: 'utf-8' });
    if (output.includes('CPU_Speed_Limit')) {
      const match = output.match(/CPU_Speed_Limit\s*=\s*(\d+)/);
      if (match) {
        const limit = parseInt(match[1], 10);
        if (limit >= 100) return 'nominal';
        if (limit >= 75) return 'fair';
        if (limit >= 50) return 'serious';
        return 'critical';
      }
    }
    return 'nominal';
  } catch {
    return undefined;
  }
}

function getMemoryUsage(): { usedBytes: number; totalBytes: number } {
  const totalBytes = os.totalmem();
  if (process.platform === 'darwin') {
    // macOS: os.freemem() excludes inactive (file cache) → inflated "used".
    // Match Activity Monitor: App (internal) + Wired + Compressed.
    // sysctl vm.page_pageable_internal_count = anonymous app pages (matches AM "App Memory").
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
      const usedBytes = (internal + wired + compressor) * pageSize;
      return { usedBytes, totalBytes };
    } catch {
      // fallback
    }
  }
  return { usedBytes: totalBytes - os.freemem(), totalBytes };
}

export function collectMetrics(): SystemMetrics {
  const { usedBytes: usedMem, totalBytes: totalMem } = getMemoryUsage();
  const [loadAvg1, loadAvg5] = os.loadavg();

  return {
    cpuPercent: getCpuPercent(),
    memoryPercent: Math.round((usedMem / totalMem) * 100),
    memoryUsedGb: Math.round((usedMem / 1073741824) * 10) / 10,
    memoryTotalGb: Math.round((totalMem / 1073741824) * 10) / 10,
    diskPercent: getDiskPercent(),
    loadAvg1: Math.round(loadAvg1 * 100) / 100,
    loadAvg5: Math.round(loadAvg5 * 100) / 100,
    thermalPressure: getThermalPressure(),
    collectedAt: new Date().toISOString(),
  };
}

// ─── Subscription timer ───

let subscriptionTimer: ReturnType<typeof setInterval> | null = null;
let onMetrics: ((m: SystemMetrics) => void) | null = null;

export function startMetricsSubscription(
  intervalMs: number,
  callback: (m: SystemMetrics) => void,
): void {
  stopMetricsSubscription();
  onMetrics = callback;
  // Take initial CPU snapshot (first reading will be 0, second will be real)
  getCpuPercent();
  subscriptionTimer = setInterval(() => {
    if (onMetrics) onMetrics(collectMetrics());
  }, intervalMs);
}

export function stopMetricsSubscription(): void {
  if (subscriptionTimer) {
    clearInterval(subscriptionTimer);
    subscriptionTimer = null;
  }
  onMetrics = null;
}
