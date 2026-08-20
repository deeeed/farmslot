// system-metrics.ts — Collect host-level CPU, memory, disk, load, thermal metrics

import { execFile, execSync } from 'node:child_process';
import os from 'node:os';

import type {
  NodeMetricsSample,
  NodeProcessInventory,
  NodeProcessSample,
} from '@farmslot/protocol';

import { getCachedResourceWatchPids, getResourceWatchRuntimeStats } from './resource-watch.js';
import { getCachedTmuxPanePids } from './tmux.js';

export type SystemMetrics = NodeMetricsSample;

const PROCESS_SAMPLE_MAX_ENTRIES = 256;
const PROCESS_SAMPLE_MAX_BYTES = 512 * 1024;
const PROCESS_SAMPLE_TIMEOUT_MS = 4_000;
const PROCESS_EXECUTABLE_MAX_CHARS = 120;
const PROCESS_SAMPLE_ELEVATED_INTERVAL_MS = 60_000;
const PROCESS_SAMPLE_NORMAL_INTERVAL_MS = 5 * 60_000;
const PROCESS_GENERATION = `${process.pid}:${new Date(Date.now() - process.uptime() * 1000).toISOString()}`;

const processSampler = {
  attempts: 0,
  executions: 0,
  failures: 0,
  skippedBusy: 0,
  skippedCadence: 0,
  lastDurationMs: null as number | null,
  lastError: undefined as string | undefined,
};
let processSampleId = 0;
let processInventoryInFlight: Promise<NodeProcessInventory> | null = null;
let lastProcessInventoryAt = 0;

export type ProcessInventoryRunner = () => Promise<string>;

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

function elapsedSeconds(value: string): number {
  const match = value.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return 0;
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match;
  return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

export function parseProcessInventory(
  output: string,
  maxEntries = PROCESS_SAMPLE_MAX_ENTRIES,
  priorityPids: ReadonlySet<number> = new Set(),
): {
  processes: NodeProcessSample[];
  totalProcesses: number;
  truncated: boolean;
  ancestryTruncated: boolean;
} {
  const parsed: NodeProcessSample[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (!match) continue;
    const [, pid, ppid, cpu, rssKb, elapsed, executable] = match;
    if (Number(ppid) === process.pid && /(?:^|\/)ps$/u.test(executable)) continue;
    parsed.push({
      pid: Number(pid),
      ppid: Number(ppid),
      cpuPercent: Number(cpu),
      rssBytes: Number(rssKb) * 1024,
      elapsedSeconds: elapsedSeconds(elapsed),
      executable: executable.slice(0, PROCESS_EXECUTABLE_MAX_CHARS),
    });
  }

  if (parsed.length <= maxEntries) {
    return {
      processes: parsed.sort((a, b) => a.pid - b.pid),
      totalProcesses: parsed.length,
      truncated: false,
      ancestryTruncated: false,
    };
  }

  const byPid = new Map(parsed.map((entry) => [entry.pid, entry]));
  const selected = new Map<number, NodeProcessSample>();
  let ancestryTruncated = false;
  const candidates = [...parsed].sort(
    (a, b) =>
      Number(priorityPids.has(b.pid)) - Number(priorityPids.has(a.pid)) ||
      b.cpuPercent - a.cpuPercent ||
      b.rssBytes - a.rssBytes ||
      a.pid - b.pid,
  );
  for (const entry of candidates) {
    if (selected.size >= maxEntries) break;
    const chain: NodeProcessSample[] = [];
    const visited = new Set<number>();
    let current: NodeProcessSample | undefined = entry;
    while (current && !selected.has(current.pid) && !visited.has(current.pid)) {
      visited.add(current.pid);
      chain.push(current);
      current = byPid.get(current.ppid);
    }
    const remaining = maxEntries - selected.size;
    const retainedChain = chain.length > remaining ? chain.slice(0, remaining) : chain;
    if (retainedChain.length < chain.length) ancestryTruncated = true;
    for (const process of retainedChain.reverse()) selected.set(process.pid, process);
  }
  return {
    processes: [...selected.values()].sort((a, b) => a.pid - b.pid),
    totalProcesses: parsed.length,
    truncated: true,
    ancestryTruncated,
  };
}

function runProcessInventoryCommand(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      [
        '-e',
        '-o',
        'pid=',
        '-o',
        'ppid=',
        '-o',
        'pcpu=',
        '-o',
        'rss=',
        '-o',
        'etime=',
        '-o',
        'comm=',
      ],
      { encoding: 'utf8', maxBuffer: PROCESS_SAMPLE_MAX_BYTES, timeout: PROCESS_SAMPLE_TIMEOUT_MS },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function samplerHealth() {
  return {
    attempts: processSampler.attempts,
    executions: processSampler.executions,
    failures: processSampler.failures,
    skippedBusy: processSampler.skippedBusy,
    skippedCadence: processSampler.skippedCadence,
    lastDurationMs: processSampler.lastDurationMs,
    ...(processSampler.lastError ? { lastError: processSampler.lastError } : {}),
  };
}

export function collectProcessInventory(
  runner: ProcessInventoryRunner = runProcessInventoryCommand,
  priorityPids: ReadonlySet<number> = new Set(),
): Promise<NodeProcessInventory> {
  processSampler.attempts += 1;
  if (processInventoryInFlight) {
    processSampler.skippedBusy += 1;
    return processInventoryInFlight;
  }
  const startedAt = Date.now();
  const sampleId = ++processSampleId;
  processSampler.executions += 1;
  processInventoryInFlight = runner()
    .then((output) => {
      processSampler.lastDurationMs = Date.now() - startedAt;
      processSampler.lastError = undefined;
      lastProcessInventoryAt = Date.now();
      const parsed = parseProcessInventory(output, PROCESS_SAMPLE_MAX_ENTRIES, priorityPids);
      return {
        generation: PROCESS_GENERATION,
        sampleId,
        collectedAt: new Date().toISOString(),
        ...parsed,
        maxEntries: PROCESS_SAMPLE_MAX_ENTRIES,
        health: samplerHealth(),
      };
    })
    .catch((error: unknown) => {
      processSampler.failures += 1;
      processSampler.lastDurationMs = Date.now() - startedAt;
      lastProcessInventoryAt = Date.now();
      processSampler.lastError = (error instanceof Error ? error.message : String(error)).slice(
        0,
        160,
      );
      return {
        generation: PROCESS_GENERATION,
        sampleId,
        collectedAt: new Date().toISOString(),
        processes: [],
        totalProcesses: 0,
        maxEntries: PROCESS_SAMPLE_MAX_ENTRIES,
        truncated: false,
        health: samplerHealth(),
      };
    })
    .finally(() => {
      processInventoryInFlight = null;
    });
  return processInventoryInFlight;
}

function ratio(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function processInventoryCadenceMs(params: {
  cpuPercent: number;
  memoryPercent: number;
  loadAvg1: number;
  cpuCores: number;
  thermalPressure?: 'nominal' | 'fair' | 'serious' | 'critical';
}): number {
  const elevated =
    params.cpuPercent >= 70 ||
    params.memoryPercent >= 80 ||
    params.loadAvg1 >= params.cpuCores ||
    (params.thermalPressure != null && params.thermalPressure !== 'nominal');
  return elevated ? PROCESS_SAMPLE_ELEVATED_INTERVAL_MS : PROCESS_SAMPLE_NORMAL_INTERVAL_MS;
}

function processInventoryDue(params: Parameters<typeof processInventoryCadenceMs>[0]): boolean {
  const interval = processInventoryCadenceMs(params);
  if (lastProcessInventoryAt === 0 || Date.now() - lastProcessInventoryAt >= interval) return true;
  processSampler.skippedCadence += 1;
  return false;
}

export async function collectMetrics(): Promise<SystemMetrics> {
  const { usedBytes: usedMem, totalBytes: totalMem } = getMemoryUsage();
  const [loadAvg1, loadAvg5] = os.loadavg();
  const cpuCores = os.cpus().length;
  const cpuPercent = getCpuPercent();
  const memoryPercent = Math.round((usedMem / totalMem) * 100);
  const diskPercent = getDiskPercent();
  const thermalPressure = getThermalPressure();
  const processInventory = processInventoryDue({
    cpuPercent,
    memoryPercent,
    loadAvg1,
    cpuCores,
    thermalPressure,
  })
    ? await collectProcessInventory(
        undefined,
        new Set([...getCachedTmuxPanePids(), ...getCachedResourceWatchPids()]),
      )
    : undefined;

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
      cpu: ratio(cpuPercent / 100),
      memory: ratio(memoryPercent / 100),
      disk: ratio(diskPercent / 100),
      load1: ratio(loadAvg1 / Math.max(1, cpuCores)),
      load5: ratio(loadAvg5 / Math.max(1, cpuCores)),
    },
    ...(processInventory ? { processInventory } : {}),
    thermalPressure,
    resourceWatches: getResourceWatchRuntimeStats(),
    collectedAt: new Date().toISOString(),
  };
}

// ─── Subscription timer ───

let subscriptionTimer: ReturnType<typeof setInterval> | null = null;
let onMetrics: ((m: SystemMetrics) => void) | null = null;
let subscriptionCollecting = false;

export function startMetricsSubscription(
  intervalMs: number,
  callback: (m: SystemMetrics) => void,
): void {
  stopMetricsSubscription();
  onMetrics = callback;
  // Take initial CPU snapshot (first reading will be 0, second will be real)
  getCpuPercent();
  subscriptionTimer = setInterval(() => {
    if (subscriptionCollecting) {
      return;
    }
    subscriptionCollecting = true;
    void collectMetrics()
      .then((metrics) => onMetrics?.(metrics))
      .finally(() => {
        subscriptionCollecting = false;
      });
  }, intervalMs);
}

export function stopMetricsSubscription(): void {
  if (subscriptionTimer) {
    clearInterval(subscriptionTimer);
    subscriptionTimer = null;
  }
  subscriptionCollecting = false;
  onMetrics = null;
}
