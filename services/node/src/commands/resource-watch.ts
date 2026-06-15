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
    intervalMs?: number; // poll interval (default: 10000)
  };
}

export type ResourceStatusValue = 'running' | 'stopped' | 'unknown' | 'relaunched';

import type { ResourceSidecarMeta } from '@farmslot/protocol';
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
}

const RELAUNCH_WINDOW_MS = 2_000;
const PORT_CHECK_TIMEOUT_MS = 1_000;

const activeWatches = new Map<string, ActiveWatch>(); // key: "slotId:resourceId"

function watchKey(slotId: string, resourceId: string): string {
  return `${slotId}:${resourceId}`;
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
  const repairCmd = aw.instruction.watch.cmd;
  if (repairCmd) {
    const status = await checkProcessStatus(repairCmd, aw.instruction.watch.cwd);
    if (status !== 'running') return { status: 'stopped' };
  }
  return checkPidFileStatus(pidPath);
}

function startPidFileWatch(
  aw: ActiveWatch,
  onChange: (change: ResourceStatusChange) => void,
): void {
  const pidPath = aw.instruction.watch.path!;
  const intervalMs = aw.instruction.watch.intervalMs ?? 10_000;

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

function runWatchPoll(aw: ActiveWatch, label: string, poll: () => Promise<void>): void {
  if (aw.pollInFlight) return;
  aw.pollInFlight = true;
  poll()
    .catch((err) => {
      console.warn(
        `[resource-watch] ${label} poll failed for ${aw.slotId}:${aw.resourceId}: ${err.message}`,
      );
    })
    .finally(() => {
      aw.pollInFlight = false;
    });
}

function startPortListenWatch(
  aw: ActiveWatch,
  onChange: (change: ResourceStatusChange) => void,
): void {
  const port = aw.instruction.watch.port!;
  const intervalMs = aw.instruction.watch.intervalMs ?? 10_000;

  const poll = async () => {
    const status = await checkPortStatus(port);
    if (status !== aw.lastStatus) {
      aw.lastStatus = status;
      onChange({ slotId: aw.slotId, resourceId: aw.resourceId, status });
    }
  };

  // Initial check
  runWatchPoll(aw, 'port', poll);
  aw.pollTimer = setInterval(() => {
    runWatchPoll(aw, 'port', poll);
  }, intervalMs);
}

// ─── Process poll watcher ───

async function checkProcessStatus(cmd: string, cwd?: string): Promise<ResourceStatusValue> {
  const result = await exec({ cmd, cwd, timeout: 5_000 });
  return result.exitCode === 0 ? 'running' : 'stopped';
}

function startProcessPollWatch(
  aw: ActiveWatch,
  onChange: (change: ResourceStatusChange) => void,
): void {
  const cmd = aw.instruction.watch.cmd!;
  const cwd = aw.instruction.watch.cwd;
  const intervalMs = aw.instruction.watch.intervalMs ?? 10_000;

  const poll = async () => {
    const status = await checkProcessStatus(cmd, cwd);
    if (status !== aw.lastStatus) {
      aw.lastStatus = status;
      onChange({ slotId: aw.slotId, resourceId: aw.resourceId, status });
    }
  };

  // Initial check
  runWatchPoll(aw, 'process', poll);
  aw.pollTimer = setInterval(() => {
    runWatchPoll(aw, 'process', poll);
  }, intervalMs);
}

// ─── Public API ───

export function startResourceWatch(
  slotId: string,
  instructions: WatchInstruction[],
  onChange: (change: ResourceStatusChange) => void,
): void {
  for (const inst of instructions) {
    const key = watchKey(slotId, inst.id);

    // Stop existing watch for this resource
    stopSingleWatch(key);

    const aw: ActiveWatch = {
      slotId,
      resourceId: inst.id,
      instruction: inst,
      lastStatus: 'unknown',
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
        if (inst.watch.cmd) startProcessPollWatch(aw, onChange);
        break;
    }

    console.log(`[resource-watch] started ${inst.watch.type} watch: ${key}`);
  }
}

function stopSingleWatch(key: string): void {
  const aw = activeWatches.get(key);
  if (!aw) return;
  if (aw.fsWatcher) aw.fsWatcher.close();
  if (aw.pollTimer) clearInterval(aw.pollTimer);
  if (aw.relaunchWindow) clearTimeout(aw.relaunchWindow);
  activeWatches.delete(key);
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
