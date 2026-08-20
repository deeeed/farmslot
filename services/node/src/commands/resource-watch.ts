// resource-watch.ts — Watch PID files, ports, and processes for resource status changes.
// Gateway sends watch instructions; node watches locally and emits events on state change.

import { existsSync, type FSWatcher, readFileSync, watch } from 'node:fs';
import net from 'node:net';

import { exec } from './exec.js';

export type WatchType = 'pid-file' | 'port-listen' | 'process-poll';

export interface WatchInstruction {
  id: string; // resource ID (e.g. "browser", "dev-server")
  watch: {
    type: WatchType;
    path?: string; // pid-file: absolute PID file path
    port?: number; // port-listen: TCP port
    cmd?: string; // process-poll: shell command (exit 0 = running)
    cwd?: string; // working directory for cmd
    /** Additive hint: new nodes coalesce this provider; old nodes still execute cmd. */
    provider?: ResourceWatchProvider;
    /** Provider-specific lookup key, such as simulator name or UDID. */
    target?: string;
    intervalMs?: number; // poll interval (default: 30000)
  };
}

export type ResourceStatusValue = 'running' | 'stopped' | 'unknown' | 'relaunched';

import type {
  ResourceSidecarMeta,
  ResourceWatchProvider,
  ResourceWatchRuntimeStats,
} from '@farmslot/protocol';
export type { ResourceSidecarMeta } from '@farmslot/protocol';

export interface ResourceStatusChange {
  slotId: string;
  resourceId: string;
  status: ResourceStatusValue;
  pid?: number;
  oldPid?: number;
  newPid?: number;
  at?: string;
  // Sidecar metadata read from `<pidPath>.meta` if present — lets gateway
  // detect stale ownership (pid from a previous run still alive).
  meta?: ResourceSidecarMeta;
}

interface ActiveWatch {
  slotId: string;
  resourceId: string;
  instruction: WatchInstruction;
  lastStatus: ResourceStatusValue;
  lastPid?: number;
  // Last-seen sidecar runId so we can detect metadata-only transitions.
  // Boot emits `running` before writeSidecarMeta finishes; the next poll sees
  // the same status+pid but newly-populated meta.runId — without tracking this
  // the emit-if-changed guard would swallow the update and the gateway's
  // stale-detection would stay keyed on the old/missing runId.
  lastMetaRunId?: string;
  fsWatcher?: FSWatcher;
  pollTimer?: ReturnType<typeof setInterval>;
  // running → stopped → running within this window collapses to `relaunched`.
  relaunchWindow?: ReturnType<typeof setTimeout>;
  relaunchPrevPid?: number;
  pollInFlight?: boolean;
  stopped?: boolean;
  onChange: (change: ResourceStatusChange) => void;
}

const RELAUNCH_WINDOW_MS = 2_000;
const PORT_CHECK_TIMEOUT_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MAX_CONCURRENT_PROCESS_POLLS = 2;
const INITIAL_PROCESS_POLL_SPREAD_MS = 5_000;
const SHARED_POLL_INITIAL_DEBOUNCE_MS = 250;
const MIN_SHARED_POLL_INTERVAL_MS = 30_000;
const IOS_SIMULATOR_INVENTORY_PROVIDER = 'ios-simulator-inventory';
const IOS_SIMULATOR_INVENTORY_TIMEOUT_MS = 10_000;

type ResourceWatchExec = typeof exec;
let executeWatchCommand: ResourceWatchExec = exec;

/** Deterministic test seam; production always uses node exec. */
export function setResourceWatchExecForTests(replacement?: ResourceWatchExec): void {
  executeWatchCommand = replacement ?? exec;
}

let activeProcessPolls = 0;
let queuedProcessPolls = 0;
const processPollWaiters: Array<() => void> = [];

let sharedIosPollTimer: ReturnType<typeof setTimeout> | undefined;
let sharedIosPollInFlight = false;
let sharedIosWatchGeneration = 0;
const sharedProcessPollStats = {
  executions: 0,
  fanout: 0,
  failures: 0,
  lastDurationMs: null as number | null,
};

/** Reset cumulative provider telemetry between deterministic test cases. */
export function resetResourceWatchStatsForTests(): void {
  sharedProcessPollStats.executions = 0;
  sharedProcessPollStats.fanout = 0;
  sharedProcessPollStats.failures = 0;
  sharedProcessPollStats.lastDurationMs = null;
}

async function withProcessPollPermit<T>(
  shouldRun: () => boolean,
  run: () => Promise<T>,
): Promise<T | undefined> {
  if (!shouldRun()) return undefined;
  if (activeProcessPolls >= MAX_CONCURRENT_PROCESS_POLLS) {
    queuedProcessPolls += 1;
    try {
      await new Promise<void>((resolve) => processPollWaiters.push(resolve));
    } finally {
      queuedProcessPolls -= 1;
    }
  } else {
    activeProcessPolls += 1;
  }
  try {
    // Watch sets are replaced on reconnect and config refresh. A queued poll
    // from the previous set must not survive that replacement and consume a
    // process slot after its timer has been stopped.
    if (!shouldRun()) return undefined;
    return await run();
  } finally {
    const next = processPollWaiters.shift();
    if (next) next();
    else activeProcessPolls -= 1;
  }
}

const activeWatches = new Map<string, ActiveWatch>(); // key: "slotId:resourceId"

function watchKey(slotId: string, resourceId: string): string {
  return `${slotId}:${resourceId}`;
}

function isWatchActive(aw: ActiveWatch): boolean {
  return !aw.stopped && activeWatches.get(watchKey(aw.slotId, aw.resourceId)) === aw;
}

function initialProcessPollDelay(aw: ActiveWatch): number {
  const key = watchKey(aw.slotId, aw.resourceId);
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % INITIAL_PROCESS_POLL_SPREAD_MS;
}

export function getResourceWatchRuntimeStats(): ResourceWatchRuntimeStats {
  const byType: Record<WatchType, number> = {
    'pid-file': 0,
    'port-listen': 0,
    'process-poll': 0,
  };
  for (const watch of activeWatches.values()) byType[watch.instruction.watch.type] += 1;
  return {
    watches: activeWatches.size,
    byType,
    activeProcessPolls,
    queuedProcessPolls,
    maxConcurrentProcessPolls: MAX_CONCURRENT_PROCESS_POLLS,
    sharedProcessPolls: {
      providers: activeIosSimulatorWatches().length > 0 ? 1 : 0,
      ...sharedProcessPollStats,
    },
  };
}

function isIosSimulatorInventoryWatch(aw: ActiveWatch): boolean {
  return (
    aw.instruction.watch.type === 'process-poll' &&
    aw.instruction.watch.provider === IOS_SIMULATOR_INVENTORY_PROVIDER &&
    Boolean(aw.instruction.watch.target)
  );
}

function activeIosSimulatorWatches(): ActiveWatch[] {
  return [...activeWatches.values()].filter(
    (watch) => isWatchActive(watch) && isIosSimulatorInventoryWatch(watch),
  );
}

function sharedIosPollIntervalMs(): number {
  const requested = activeIosSimulatorWatches().map(
    (watch) => watch.instruction.watch.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );
  return Math.max(MIN_SHARED_POLL_INTERVAL_MS, requested.length > 0 ? Math.min(...requested) : 0);
}

export function parseBootedIosSimulatorInventory(stdout: string): Set<string> {
  const parsed = JSON.parse(stdout) as {
    devices?: Record<string, Array<{ name?: unknown; udid?: unknown; state?: unknown }>>;
  };
  const booted = new Set<string>();
  for (const devices of Object.values(parsed.devices ?? {})) {
    for (const device of devices) {
      if (device.state !== 'Booted') continue;
      if (typeof device.name === 'string' && device.name) booted.add(device.name);
      if (typeof device.udid === 'string' && device.udid) booted.add(device.udid);
    }
  }
  return booted;
}

function scheduleSharedIosPoll(delayMs: number): void {
  if (sharedIosPollTimer || sharedIosPollInFlight || activeIosSimulatorWatches().length === 0)
    return;
  sharedIosPollTimer = setTimeout(() => {
    sharedIosPollTimer = undefined;
    void runSharedIosPoll();
  }, delayMs);
}

async function runSharedIosPoll(): Promise<void> {
  if (sharedIosPollInFlight) return;
  const generation = sharedIosWatchGeneration;
  const watches = activeIosSimulatorWatches();
  if (watches.length === 0) return;
  sharedIosPollInFlight = true;
  let executionStartedAt: number | null = null;
  try {
    const result = await withProcessPollPermit(
      () => watches.some(isWatchActive),
      async () => {
        executionStartedAt = Date.now();
        sharedProcessPollStats.executions += 1;
        return executeWatchCommand({
          argv: ['xcrun', 'simctl', 'list', 'devices', 'booted', '-j'],
          timeout: IOS_SIMULATOR_INVENTORY_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
        });
      },
    );
    if (!result) return;
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `simctl exited ${result.exitCode}`);
    }
    const booted = parseBootedIosSimulatorInventory(result.stdout);
    for (const watch of watches) {
      if (!isWatchActive(watch)) continue;
      const target = watch.instruction.watch.target!;
      const status: ResourceStatusValue = booted.has(target) ? 'running' : 'stopped';
      sharedProcessPollStats.fanout += 1;
      if (status === watch.lastStatus) continue;
      watch.lastStatus = status;
      watch.onChange({ slotId: watch.slotId, resourceId: watch.resourceId, status });
    }
  } catch (error) {
    sharedProcessPollStats.failures += 1;
    console.warn(
      `[resource-watch] shared ${IOS_SIMULATOR_INVENTORY_PROVIDER} poll failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (executionStartedAt !== null) {
      sharedProcessPollStats.lastDurationMs = Date.now() - executionStartedAt;
    }
    sharedIosPollInFlight = false;
    const watchesChanged = generation !== sharedIosWatchGeneration;
    scheduleSharedIosPoll(
      watchesChanged ? SHARED_POLL_INITIAL_DEBOUNCE_MS : sharedIosPollIntervalMs(),
    );
  }
}

function startSharedIosSimulatorWatch(): void {
  sharedIosWatchGeneration += 1;
  if (sharedIosPollTimer) {
    clearTimeout(sharedIosPollTimer);
    sharedIosPollTimer = undefined;
  }
  scheduleSharedIosPoll(SHARED_POLL_INITIAL_DEBOUNCE_MS);
}

// ─── PID file watcher ───

function readPidFile(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function readSidecarMeta(pidPath: string): ResourceSidecarMeta | undefined {
  const metaPath = `${pidPath}.meta`;
  try {
    const content = readFileSync(metaPath, 'utf-8').trim();
    if (!content) return undefined;
    const parsed = JSON.parse(content) as Partial<ResourceSidecarMeta>;
    if (
      typeof parsed.runId === 'string' &&
      parsed.runId.length > 0 &&
      typeof parsed.slotId === 'string' &&
      parsed.slotId.length > 0 &&
      typeof parsed.startedAt === 'string' &&
      parsed.startedAt.length > 0
    ) {
      return { runId: parsed.runId, slotId: parsed.slotId, startedAt: parsed.startedAt };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function checkPidFileStatus(path: string): {
  status: ResourceStatusValue;
  pid?: number;
  meta?: ResourceSidecarMeta;
} {
  const pid = readPidFile(path);
  if (pid === null) return { status: 'stopped' };
  if (isProcessAlive(pid)) return { status: 'running', pid, meta: readSidecarMeta(path) };
  return { status: 'stopped' }; // zombie: PID file exists but process is dead
}

async function checkPidFileStatusWithRepair(aw: ActiveWatch): Promise<{
  status: ResourceStatusValue;
  pid?: number;
  meta?: ResourceSidecarMeta;
}> {
  const pidPath = aw.instruction.watch.path!;
  const current = checkPidFileStatus(pidPath);
  if (current.status === 'running') return current;

  const repairCmd = aw.instruction.watch.cmd;
  if (repairCmd) {
    const status = await checkProcessStatus(aw, repairCmd, aw.instruction.watch.cwd);
    if (!status) return current;
    if (status !== 'running') return { status: 'stopped' };
  }
  return checkPidFileStatus(pidPath);
}

function startPidFileWatch(
  aw: ActiveWatch,
  onChange: (change: ResourceStatusChange) => void,
): void {
  const pidPath = aw.instruction.watch.path!;
  const intervalMs = aw.instruction.watch.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const flushRelaunchAsStopped = () => {
    aw.relaunchWindow = undefined;
    const prevPid = aw.relaunchPrevPid;
    aw.relaunchPrevPid = undefined;
    aw.lastStatus = 'stopped';
    aw.lastPid = undefined;
    aw.lastMetaRunId = undefined;
    onChange({ slotId: aw.slotId, resourceId: aw.resourceId, status: 'stopped', pid: prevPid });
  };

  const emitIfChanged = async (force = false) => {
    const current = await checkPidFileStatusWithRepair(aw);
    const currentMetaRunId = current.meta?.runId;
    // Emit when status, pid, OR meta.runId changes. Pure metadata transitions
    // happen on the first poll after boot: the pidfile appears (running) a
    // few polls before writeSidecarMeta lands, so status+pid stay stable
    // while meta.runId flips from undefined to the real run id. Without
    // forwarding that transition, gateway stale detection keys on a stale
    // or missing runId until the next real state change.
    if (
      !force &&
      current.status === aw.lastStatus &&
      current.pid === aw.lastPid &&
      currentMetaRunId === aw.lastMetaRunId
    )
      return;

    // running → stopped: open the coalescing window instead of emitting.
    if (aw.lastStatus === 'running' && current.status === 'stopped') {
      aw.relaunchPrevPid = aw.lastPid;
      aw.lastStatus = 'stopped';
      aw.lastPid = undefined;
      aw.lastMetaRunId = undefined;
      if (aw.relaunchWindow) clearTimeout(aw.relaunchWindow);
      aw.relaunchWindow = setTimeout(flushRelaunchAsStopped, RELAUNCH_WINDOW_MS);
      return;
    }

    // stopped → running inside the window: coalesce into a single `relaunched` event.
    if (aw.relaunchWindow && current.status === 'running' && current.pid) {
      clearTimeout(aw.relaunchWindow);
      aw.relaunchWindow = undefined;
      const oldPid = aw.relaunchPrevPid ?? 0;
      aw.relaunchPrevPid = undefined;
      aw.lastStatus = 'running';
      aw.lastPid = current.pid;
      aw.lastMetaRunId = currentMetaRunId;
      onChange({
        slotId: aw.slotId,
        resourceId: aw.resourceId,
        status: 'relaunched',
        oldPid,
        newPid: current.pid,
        pid: current.pid,
        at: new Date().toISOString(),
        ...(current.meta ? { meta: current.meta } : {}),
      });
      return;
    }

    aw.lastStatus = current.status;
    aw.lastPid = current.pid;
    aw.lastMetaRunId = currentMetaRunId;
    onChange({
      slotId: aw.slotId,
      resourceId: aw.resourceId,
      status: current.status,
      pid: current.pid,
      ...(current.meta ? { meta: current.meta } : {}),
    });
  };

  const runPoll = (force = false, source = 'pid-file') => {
    if (aw.pollInFlight) return;
    aw.pollInFlight = true;
    emitIfChanged(force)
      .catch((err) => {
        console.warn(`[resource-watch] ${source} poll failed for ${pidPath}: ${err.message}`);
      })
      .finally(() => {
        aw.pollInFlight = false;
      });
  };

  // fs.watch on the PID file (detects create/delete/modify)
  // Watch the directory since the file may not exist yet
  const dir = pidPath.substring(0, pidPath.lastIndexOf('/'));
  const filename = pidPath.substring(pidPath.lastIndexOf('/') + 1);

  try {
    aw.fsWatcher = watch(dir, { persistent: false }, (_eventType, changedFile) => {
      if (changedFile === filename) {
        // Small delay for file write to complete
        setTimeout(() => {
          runPoll(false, 'pid-file');
        }, 100);
      }
    });
  } catch {
    // Directory doesn't exist yet — rely on polling only
    console.log(`[resource-watch] dir not found for ${pidPath}, polling only`);
  }

  // Initial check — emit current state so gateway rebuilds `activeResource`
  // after a restart. Without this, a long-lived `running` resource stays
  // invisible until its next state transition.
  runPoll(true, 'initial pid-file');

  // Periodic zombie detection (kill -0 check)
  aw.pollTimer = setInterval(() => {
    runPoll(false, 'pid-file');
  }, intervalMs);
}

// ─── Port listen watcher ───

function canConnectToPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PORT_CHECK_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function checkPortStatus(port: number): Promise<ResourceStatusValue> {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return 'stopped';
  const [ipv4, ipv6] = await Promise.all([
    canConnectToPort(port, '127.0.0.1'),
    canConnectToPort(port, '::1'),
  ]);
  return ipv4 || ipv6 ? 'running' : 'stopped';
}

async function runWatchPoll(
  aw: ActiveWatch,
  label: string,
  poll: () => Promise<void>,
): Promise<void> {
  if (aw.pollInFlight) return;
  aw.pollInFlight = true;
  try {
    await poll();
  } catch (err) {
    console.warn(
      `[resource-watch] ${label} poll failed for ${aw.slotId}:${aw.resourceId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    aw.pollInFlight = false;
  }
}

function startPortListenWatch(
  aw: ActiveWatch,
  onChange: (change: ResourceStatusChange) => void,
): void {
  const port = aw.instruction.watch.port!;
  const intervalMs = aw.instruction.watch.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const poll = async () => {
    const status = await checkPortStatus(port);
    if (status !== aw.lastStatus) {
      aw.lastStatus = status;
      onChange({ slotId: aw.slotId, resourceId: aw.resourceId, status });
    }
  };

  // Initial check
  void runWatchPoll(aw, 'port', poll);
  aw.pollTimer = setInterval(() => {
    void runWatchPoll(aw, 'port', poll);
  }, intervalMs);
}

// ─── Process poll watcher ───

async function checkProcessStatus(
  aw: ActiveWatch,
  cmd: string,
  cwd?: string,
): Promise<ResourceStatusValue | undefined> {
  return withProcessPollPermit(
    () => isWatchActive(aw),
    async () => {
      const result = await executeWatchCommand({ cmd, cwd, timeout: 5_000 });
      return result.exitCode === 0 ? 'running' : 'stopped';
    },
  );
}

function startProcessPollWatch(
  aw: ActiveWatch,
  onChange: (change: ResourceStatusChange) => void,
): void {
  const cmd = aw.instruction.watch.cmd!;
  const cwd = aw.instruction.watch.cwd;
  const intervalMs = aw.instruction.watch.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const poll = async () => {
    const status = await checkProcessStatus(aw, cmd, cwd);
    if (!status) return;
    if (status !== aw.lastStatus) {
      aw.lastStatus = status;
      onChange({ slotId: aw.slotId, resourceId: aw.resourceId, status });
    }
  };

  // Stagger expensive initial probes across the host. Schedule each next poll
  // only after the previous one completes, so a slow command cannot build an
  // unbounded per-watch backlog.
  const schedule = (delayMs: number) => {
    aw.pollTimer = setTimeout(async () => {
      if (!isWatchActive(aw)) return;
      await runWatchPoll(aw, 'process', poll);
      if (isWatchActive(aw)) schedule(intervalMs);
    }, delayMs);
  };
  schedule(initialProcessPollDelay(aw));
}

// ─── Public API ───

export function startResourceWatch(
  slotId: string,
  instructions: WatchInstruction[],
  onChange: (change: ResourceStatusChange) => void,
): number {
  // Each start request is the authoritative watch set for the slot. Without
  // clearing omitted IDs, configuration changes leave old pollers running and
  // keep publishing resources that no longer belong to the slot.
  stopResourceWatch(slotId);

  for (const inst of instructions) {
    const key = watchKey(slotId, inst.id);

    const aw: ActiveWatch = {
      slotId,
      resourceId: inst.id,
      instruction: inst,
      lastStatus: 'unknown',
      onChange,
    };
    activeWatches.set(key, aw);

    switch (inst.watch.type) {
      case 'pid-file':
        if (inst.watch.path) startPidFileWatch(aw, onChange);
        break;
      case 'port-listen':
        if (inst.watch.port) startPortListenWatch(aw, onChange);
        break;
      case 'process-poll':
        if (inst.watch.provider === IOS_SIMULATOR_INVENTORY_PROVIDER && inst.watch.target) {
          startSharedIosSimulatorWatch();
        } else if (inst.watch.cmd) {
          startProcessPollWatch(aw, onChange);
        }
        break;
    }

    console.log(`[resource-watch] started ${inst.watch.type} watch: ${key}`);
  }

  return instructions.length;
}

function stopSingleWatch(key: string): void {
  const aw = activeWatches.get(key);
  if (!aw) return;
  const wasSharedIosWatch = isIosSimulatorInventoryWatch(aw);
  aw.stopped = true;
  if (aw.fsWatcher) aw.fsWatcher.close();
  if (aw.pollTimer) clearInterval(aw.pollTimer);
  if (aw.relaunchWindow) clearTimeout(aw.relaunchWindow);
  activeWatches.delete(key);
  if (wasSharedIosWatch) {
    const remainingSharedWatches = activeIosSimulatorWatches();
    if (sharedIosPollTimer) {
      clearTimeout(sharedIosPollTimer);
      sharedIosPollTimer = undefined;
    }
    if (remainingSharedWatches.length > 0) {
      const hasUninitializedWatch = remainingSharedWatches.some(
        (watch) => watch.lastStatus === 'unknown',
      );
      scheduleSharedIosPoll(
        hasUninitializedWatch ? SHARED_POLL_INITIAL_DEBOUNCE_MS : sharedIosPollIntervalMs(),
      );
    }
  }
}

export function stopResourceWatch(slotId: string): void {
  for (const [key, aw] of activeWatches) {
    if (aw.slotId === slotId) {
      stopSingleWatch(key);
      console.log(`[resource-watch] stopped: ${key}`);
    }
  }
}

export function stopAllResourceWatches(): void {
  for (const key of Array.from(activeWatches.keys())) {
    stopSingleWatch(key);
  }
  console.log(`[resource-watch] stopped all watches`);
}
