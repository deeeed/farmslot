// screen-session.ts — Spawn capture process per slot, multicast H.264 frames to subscribers
// Mirrors pty-stream.ts pattern: lazy spawn on first subscriber, kill on last unsubscriber.
// Supports iOS (capture-helper --framed) and Android (adb screenrecord raw Annex B).
// Dual mode: 'direct' (gateway spawns capture) or 'node' (node spawns, gateway relays).

import { type ChildProcess, spawn } from 'node:child_process';

import {
  createH264FrameSplitter,
  type H264FrameSplitter,
} from '@farmslot/capabilities/screen-h264';
import type { BrowserContextParams, ResourceRelaunchedPayload } from '@farmslot/protocol';

import { loadProjectVars, loadSlotVars } from '../core/config.js';
import { type ConnectedNode, getNode } from '../fleet/machine-registry.js';
import { getSlotLocality, sendNodeRequest } from '../fleet/node-rpc.js';
import { getActiveResource, onResourceRelaunched } from '../fleet/resource-manager.js';
import { getCachedFleet } from '../fleet/state.js';
import { resolveBrowserPid, resolveSlotStreamAsync } from '../methods/stream-resolve.js';

// Resource id used by chromium/browser resources across projects. Matches the
// key in project.json `resources.browser` — the sticky pointer is keyed by the
// same id the node uses for pid-file watching.
const BROWSER_RESOURCE_ID = 'browser';

// Prefer the sticky pointer maintained by resource-manager so relaunches swap
// the pid without dropping the stream session. Falls back to the subscribe-time
// capture when no pointer is active yet.
function stickyBrowserPid(slotId: string, fallback: number | null): number | null {
  const ptr = getActiveResource(slotId, BROWSER_RESOURCE_ID);
  if (ptr && ptr.pid > 0) return ptr.pid;
  return fallback;
}

export type ScreenFrameHandler = (payload: Uint8Array, keyFrame: boolean) => void;

interface ScreenSession {
  proc: ChildProcess | null; // null for agent-mediated
  sessionKey: string;
  slotId: string;
  platform: string;
  resourceId?: string;
  width: number;
  height: number;
  handlers: Set<ScreenFrameHandler>;
  id: number;
  h264?: H264FrameSplitter; // set only for direct Android capture
  mode: 'direct' | 'node';
  machine?: string; // set when mode='node'
}

// Track which WebSocket owns each handler (for dead-WS reaping)
const handlerClients = new Map<ScreenFrameHandler, import('ws').WebSocket>();

const sessions = new Map<string, ScreenSession>();
let nextId = 0;
let reaperTimer: ReturnType<typeof setInterval> | null = null;

const NODE_SCREEN_SUBSCRIBE_TIMEOUT_MS = 60_000;
const NODE_SCREEN_SUBSCRIBE_RETRY_DELAY_MS = 1_000;

function log(action: string, sessionKey: string, detail?: string) {
  const parts = [`[screen] ${action} slot=${sessionKey}`];
  if (detail) parts.push(detail);
  const ss = sessions.get(sessionKey);
  if (ss) {
    const pidStr = ss.proc ? `pid=${ss.proc.pid}` : `mode=${ss.mode}`;
    parts.push(`id=${ss.id} handlers=${ss.handlers.size} ${pidStr}`);
  }
  console.log(parts.join(' '));
}

function resolveSlotInfo(slotId: string): { platform: string; ssh?: string } {
  const fleet = getCachedFleet();
  if (fleet) {
    const slot = fleet.slots.find((s) => s.slot === slotId);
    if (slot) {
      return { platform: slot.platform };
    }
  }
  return { platform: 'ios' };
}

// --- Android: adb screenrecord raw H.264 ---

function spawnAndroid(
  sessionKey: string,
  slotId: string,
  resourceId: string | undefined,
  serial: string,
  maxSize: number,
  ssh?: string,
  restartCount = 0,
): ScreenSession {
  const id = ++nextId;
  const sizeArg = `${maxSize}x${maxSize}`;
  log(
    'spawn-android',
    sessionKey,
    `serial=${serial} size=${maxSize} ssh=${ssh ?? 'local'} restart=${restartCount}`,
  );

  let proc: ChildProcess;
  const adbArgs = [
    '-s',
    serial,
    'exec-out',
    'screenrecord',
    '--output-format=h264',
    '--size',
    sizeArg,
    '--bit-rate',
    '500000',
    '-',
  ];

  if (ssh) {
    // Remote: run adb via SSH
    proc = spawn(
      'ssh',
      ['-o', 'ConnectTimeout=5', ssh, `$HOME/Android/Sdk/platform-tools/adb ${adbArgs.join(' ')}`],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } else {
    // Local: run adb directly
    proc = spawn('adb', adbArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  const ss: ScreenSession = {
    proc,
    sessionKey,
    slotId,
    platform: 'android',
    resourceId,
    width: 0,
    height: 0,
    handlers: new Set(),
    id,
    mode: 'direct',
  };

  // Parse raw Annex B stream via the shared splitter (@farmslot/capabilities) — the same
  // parser the node uses. Emits grouped H.264 frames, multicast to this session's handlers.
  ss.h264 = createH264FrameSplitter((payload, keyFrame) => emitFrame(ss, payload, keyFrame));
  proc.stdout!.on('data', (chunk: Buffer) => ss.h264!.push(chunk));

  wireStderrLogs(proc, ss);

  // screenrecord has a 180s limit — restart on exit if handlers still active
  proc.on('exit', (code) => {
    const current = sessions.get(sessionKey);
    if (current === ss && ss.handlers.size > 0) {
      const nextRestart = restartCount + 1;
      if (nextRestart >= 3) {
        log(
          'error',
          sessionKey,
          `screenrecord exited code=${code}, max restarts (${nextRestart}) reached — stopping`,
        );
        sessions.delete(sessionKey);
        return;
      }
      log('restart', sessionKey, `screenrecord exited code=${code}, restarting (${nextRestart}/3)`);
      const newSs = spawnAndroid(sessionKey, slotId, resourceId, serial, maxSize, ssh, nextRestart);
      // Transfer handlers
      for (const h of ss.handlers) newSs.handlers.add(h);
    } else if (current === ss) {
      sessions.delete(sessionKey);
      log('exit', sessionKey, `code=${code}`);
    }
  });

  sessions.set(sessionKey, ss);
  return ss;
}

// --- Shared helpers ---

function emitFrame(ss: ScreenSession, payload: Uint8Array, keyFrame: boolean): void {
  for (const handler of [...ss.handlers]) {
    try {
      handler(payload, keyFrame);
    } catch (error) {
      // A throwing subscriber is already unusable for future frames. Drop only
      // that handler so one dead WebSocket/client cannot break the stream for
      // other subscribers.
      ss.handlers.delete(handler);
      handlerClients.delete(handler);
      console.warn(`[screen] dropping failing subscriber slot=${ss.sessionKey}: ${String(error)}`);
    }
  }
  if (ss.handlers.size === 0) {
    killSession(ss.sessionKey);
  }
}

function wireStderrLogs(proc: ChildProcess, ss: ScreenSession): void {
  let stderrBuf = '';
  proc.stderr!.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        console.log(`[screen] capture slot=${ss.slotId}: [${msg.type}] ${msg.msg}`);
        const sizeMatch = msg.msg?.match(/output size: (\d+)x(\d+)/);
        if (sizeMatch) {
          ss.width = parseInt(sizeMatch[1], 10);
          ss.height = parseInt(sizeMatch[2], 10);
        }
      } catch {
        console.log(`[screen] capture slot=${ss.slotId}: ${line}`);
      }
    }
  });
}

function killSession(key: string): void {
  const ss = sessions.get(key);
  if (!ss) return;
  log('kill', key);
  sessions.delete(key);
  ss.handlers.clear();
  if (ss.mode === 'node' && ss.machine) {
    // Best-effort remote cleanup: the local session is already removed, and a
    // failed unsubscribe only leaves the node stream to expire via node/socket
    // lifecycle cleanup rather than blocking gateway teardown.
    const node = getNode(ss.machine);
    if (node) {
      void sendNodeRequest(node, 'screen.unsubscribe', {
        slotId: ss.slotId,
        ...(ss.resourceId ? { resourceId: ss.resourceId } : {}),
        platform: ss.platform,
      }).catch((error: unknown) => {
        console.warn(
          `[screen] remote unsubscribe failed slot=${ss.slotId} machine=${ss.machine}: ${String(error)}`,
        );
      });
    }
  } else if (ss.proc) {
    ss.proc.kill('SIGTERM');
  }
}

// --- Remote PID resolution ---

/** Resolve repo/runtimeDir/cdpPort for a chrome-extension/web slot, plus read the remote browser PID.
 *  Returns empty context when the slot isn't found or isn't browser-based. */
async function resolveBrowserContext(
  node: ConnectedNode,
  slotId: string,
): Promise<BrowserContextParams> {
  let repo: string | undefined;
  let runtimeDir: string | undefined;
  let cdpPort: number | undefined;
  try {
    const sv = await loadSlotVars(slotId);
    repo = sv.remoteRepo;
    const pv = await loadProjectVars(sv.projectName);
    runtimeDir = pv.runtimeDir;
    const rawPort = sv.resourceVars.cdp_port;
    if (rawPort) {
      const parsed = parseInt(rawPort, 10);
      if (!isNaN(parsed)) cdpPort = parsed;
    }
  } catch {
    /* slot not resolvable — fall through with partial context */
  }

  let browserPid: number | null = null;
  if (repo && runtimeDir) {
    try {
      const dir = `${repo}/${runtimeDir}`;
      const cmd = `cat "${dir}/chromium.pid" 2>/dev/null || { BPID=$(cat "${dir}/browser.pid" 2>/dev/null) && [ -n "$BPID" ] && CPID=$(pgrep -P "$BPID" 2>/dev/null | while read p; do ps -p "$p" -o comm= 2>/dev/null | grep -qi chrom && echo "$p" && break; done) && [ -n "$CPID" ] && echo "$CPID" || echo "$BPID"; }`;
      const result = (await sendNodeRequest(node, 'exec', { cmd, timeout: 3000 })) as {
        stdout: string;
        exitCode: number;
      };
      if (result.exitCode === 0 && result.stdout?.trim()) {
        const pid = parseInt(result.stdout.trim(), 10);
        if (!isNaN(pid)) browserPid = pid;
      }
    } catch {
      /* node unreachable or exec failed */
    }
  }
  return { browserPid, cdpPort, repo, runtimeDir };
}

// --- Public API ---

export async function subscribeScreen(
  slotId: string,
  deviceId: string,
  handler: ScreenFrameHandler,
  maxFps = 15,
  maxSize = 720,
  platformOverride?: string,
  ws?: import('ws').WebSocket,
  resourceId?: string,
): Promise<void> {
  const info = resolveSlotInfo(slotId);
  const devInfo = await resolveSlotStreamAsync(slotId);
  const platform = platformOverride ?? info.platform;
  const key = `${slotId}:${resourceId ?? platform}`;

  let ss = sessions.get(key);
  if (!ss) {
    // Try agent-mediated capture first
    let machine: string | undefined;
    try {
      const locality = await getSlotLocality(slotId);
      machine = locality.machine;
    } catch {
      /* slot not found — fall through to direct */
    }

    const node = machine ? getNode(machine) : undefined;

    if (node) {
      // Node-mediated: resolve PID on the remote machine (gateway-local paths would collide
      // with same-named repos on other machines — always ask the node for browser platforms).
      let browserPid: number | null = null;
      let ctx: BrowserContextParams = { browserPid: null };
      if (platform === 'chrome-extension' || platform === 'web') {
        ctx = await resolveBrowserContext(node, slotId);
        browserPid = stickyBrowserPid(slotId, ctx.browserPid ?? null);
      } else {
        browserPid = stickyBrowserPid(slotId, await resolveBrowserPid(slotId));
      }
      const subscribeParams = {
        slotId,
        resourceId,
        platform,
        maxFps,
        maxSize,
        windowAppName: platform === 'ios' ? 'Simulator' : undefined,
        iosWindowName: devInfo.iosWindowName,
        androidSerial: devInfo.androidSerial,
        browserPid,
        cdpPort: ctx.cdpPort,
        repo: ctx.repo,
        runtimeDir: ctx.runtimeDir,
      };
      log(
        'node-mediated',
        key,
        `machine=${machine} browserPid=${browserPid} cdpPort=${ctx.cdpPort ?? 'none'}`,
      );
      try {
        await sendNodeRequest(node, 'screen.subscribe', subscribeParams, {
          timeout: NODE_SCREEN_SUBSCRIBE_TIMEOUT_MS,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('timeout')) throw err;
        log('node-mediated-retry', key, msg);
        await new Promise((resolve) => setTimeout(resolve, NODE_SCREEN_SUBSCRIBE_RETRY_DELAY_MS));
        await sendNodeRequest(node, 'screen.subscribe', subscribeParams, {
          timeout: NODE_SCREEN_SUBSCRIBE_TIMEOUT_MS,
        });
      }
      const id = ++nextId;
      ss = {
        proc: null,
        sessionKey: key,
        slotId,
        platform,
        resourceId,
        width: 0,
        height: 0,
        handlers: new Set(),
        id,
        mode: 'node',
        machine,
      };
      sessions.set(key, ss);
    } else {
      // Direct fallback: existing spawn logic
      if (platform === 'android') {
        ss = spawnAndroid(key, slotId, resourceId, devInfo.androidSerial, maxSize, info.ssh);
      } else {
        log(
          'error',
          key,
          'direct macOS screen capture is unsupported; route through the canonical node owner',
        );
        throw new Error(
          'direct macOS screen capture is unsupported; start a node agent so capture routes through the canonical macOS owner',
        );
      }
    }
  }
  ss.handlers.add(handler);
  if (ws) handlerClients.set(handler, ws);
  log('subscribe', key);
}

export function unsubscribeScreen(key: string, handler: ScreenFrameHandler): void {
  const ss = sessions.get(key);
  if (!ss) return;
  ss.handlers.delete(handler);
  handlerClients.delete(handler);
  log('unsubscribe', key);
  if (ss.handlers.size === 0) {
    killSession(key);
  }
}

export function unsubscribeAllScreens(handler: ScreenFrameHandler): void {
  for (const [slotId, ss] of sessions) {
    ss.handlers.delete(handler);
    if (ss.handlers.size === 0) {
      killSession(slotId);
    }
  }
}

export function killSlotScreenSessions(slotId: string): void {
  for (const [key] of sessions) {
    if (key.startsWith(slotId + ':')) killSession(key);
  }
}

export function getScreenSession(slotId: string): {
  width: number;
  height: number;
  active: boolean;
} {
  const ss = sessions.get(slotId);
  if (!ss) return { width: 0, height: 0, active: false };
  return { width: ss.width, height: ss.height, active: true };
}

export function hasScreenSession(key: string): boolean {
  const ss = sessions.get(key);
  return !!ss && ss.handlers.size > 0;
}

/** Ingest a decoded binary frame from a node — relay to all node-mode subscribers for this slot */
export function ingestNodeFrame(
  slotId: string,
  payload: Uint8Array,
  keyFrame: boolean,
  width: number,
  height: number,
): void {
  for (const [key, ss] of sessions) {
    if (key.startsWith(slotId + ':') && ss.mode === 'node') {
      if (width > 0) ss.width = width;
      if (height > 0) ss.height = height;
      emitFrame(ss, payload, keyFrame);
    }
  }
}

/** Reap handlers whose WebSocket is no longer open */
function reapDeadHandlers(): void {
  let reaped = 0;
  for (const [key, ss] of sessions) {
    for (const handler of ss.handlers) {
      const ws = handlerClients.get(handler);
      if (ws && ws.readyState !== 1 /* OPEN */) {
        ss.handlers.delete(handler);
        handlerClients.delete(handler);
        reaped++;
      }
    }
    if (ss.handlers.size === 0) {
      killSession(key);
    }
  }
  if (reaped > 0) {
    console.log(`[screen] reaper: cleaned ${reaped} dead handler(s)`);
  }
}

export function startScreenReaper(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(reapDeadHandlers, 30_000);
  reaperTimer.unref();
}

export function stopScreenReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}

/** Clean up all node-mediated sessions for a disconnected machine.
 *  Sessions with active handlers are kept alive — they'll be re-subscribed on reconnect. */
export function cleanupAgentScreenSessions(machine: string): void {
  for (const [key, ss] of sessions) {
    if (ss.mode === 'node' && ss.machine === machine) {
      if (ss.handlers.size === 0) {
        sessions.delete(key);
        log('node-cleanup', key, `machine=${machine}`);
      } else {
        log(
          'node-paused',
          key,
          `machine=${machine} handlers=${ss.handlers.size} (kept for reconnect)`,
        );
      }
    }
  }
}

/** Re-issue `screen.subscribe` for active browser-class sessions whose pid
 *  just changed. Without this, the node keeps capturing the old (now-dead)
 *  Chromium process until the viewer reconnects. `startCapture` on the node
 *  side is idempotent — it stops the existing capture for the same slot/key
 *  before starting the new one — so re-subscribing replaces cleanly. */
async function rebindBrowserSessions(payload: ResourceRelaunchedPayload): Promise<void> {
  const { slotId, resourceId, newPid } = payload;
  if (resourceId !== BROWSER_RESOURCE_ID) return;
  if (newPid <= 0) return;

  for (const [key, ss] of sessions) {
    if (ss.slotId !== slotId) continue;
    if (ss.mode !== 'node') continue;
    if (ss.platform !== 'chrome-extension' && ss.platform !== 'web') continue;
    if (ss.resourceId !== resourceId) continue;

    const machine = ss.machine;
    if (!machine) continue;
    const node = getNode(machine);
    if (!node) continue;

    try {
      const devInfo = await resolveSlotStreamAsync(slotId);
      const ctx = await resolveBrowserContext(node, slotId);
      log('node-rebind', key, `oldPid=${payload.oldPid} newPid=${newPid}`);
      await sendNodeRequest(
        node,
        'screen.subscribe',
        {
          slotId,
          ...(ss.resourceId ? { resourceId: ss.resourceId } : {}),
          platform: ss.platform,
          maxFps: 15,
          maxSize: 720,
          iosWindowName: devInfo.iosWindowName,
          androidSerial: devInfo.androidSerial,
          browserPid: newPid,
          cdpPort: ctx.cdpPort,
          repo: ctx.repo,
          runtimeDir: ctx.runtimeDir,
        },
        { timeout: NODE_SCREEN_SUBSCRIBE_TIMEOUT_MS },
      );
    } catch (err) {
      log('node-rebind-fail', key, (err as Error).message);
    }
  }
}

let relaunchUnsubscribe: (() => void) | null = null;

/** Register a listener so capture sessions rebind to a fresh pid the instant
 *  resource-manager sees a relaunch. Call once during server startup. */
export function startScreenRelaunchWatcher(): void {
  if (relaunchUnsubscribe) return;
  relaunchUnsubscribe = onResourceRelaunched((payload) => {
    rebindBrowserSessions(payload).catch((err) => {
      console.warn(`[screen] relaunch rebind error: ${(err as Error).message}`);
    });
  });
}

export function stopScreenRelaunchWatcher(): void {
  if (relaunchUnsubscribe) {
    relaunchUnsubscribe();
    relaunchUnsubscribe = null;
  }
}

/** Re-subscribe node-mediated screen sessions after a node reconnects.
 *  Finds existing sessions for this machine and re-sends screen.subscribe RPCs. */
export async function resubscribeAgentScreenSessions(machine: string): Promise<void> {
  const node = getNode(machine);
  if (!node) return;

  for (const [key, ss] of sessions) {
    if (ss.mode !== 'node' || ss.machine !== machine) continue;

    // Prune dead handlers
    for (const handler of ss.handlers) {
      const ws = handlerClients.get(handler);
      if (ws && ws.readyState !== 1) {
        ss.handlers.delete(handler);
        handlerClients.delete(handler);
      }
    }
    if (ss.handlers.size === 0) {
      sessions.delete(key);
      continue;
    }

    const slotId = ss.slotId;
    const platform = ss.platform;
    const resourceId = ss.resourceId;

    try {
      const devInfo = await resolveSlotStreamAsync(slotId);
      let browserPid: number | null = null;
      let ctx: BrowserContextParams = { browserPid: null };
      if (platform === 'chrome-extension' || platform === 'web') {
        ctx = await resolveBrowserContext(node, slotId);
        browserPid = stickyBrowserPid(slotId, ctx.browserPid ?? null);
      } else {
        browserPid = stickyBrowserPid(slotId, await resolveBrowserPid(slotId));
      }

      log(
        'node-resub',
        key,
        `machine=${machine} browserPid=${browserPid} cdpPort=${ctx.cdpPort ?? 'none'} handlers=${ss.handlers.size}`,
      );
      await sendNodeRequest(
        node,
        'screen.subscribe',
        {
          slotId,
          ...(resourceId ? { resourceId } : {}),
          platform,
          maxFps: 15,
          maxSize: 720,
          windowAppName: platform === 'ios' ? 'Simulator' : undefined,
          iosWindowName: devInfo.iosWindowName,
          androidSerial: devInfo.androidSerial,
          browserPid,
          cdpPort: ctx.cdpPort,
          repo: ctx.repo,
          runtimeDir: ctx.runtimeDir,
        },
        { timeout: NODE_SCREEN_SUBSCRIBE_TIMEOUT_MS },
      );
    } catch (err) {
      log('node-resub-fail', key, (err as Error).message);
    }
  }
}
