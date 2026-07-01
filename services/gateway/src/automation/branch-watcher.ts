// branch-watcher.ts — Watches .git/HEAD for all enabled slots, broadcasts branch changes.
// ADR-046: the node owns machine-local monitoring, so watches route through the machine's
// node fs.watch (local via loopback, uniform with remote). When a LOCAL machine has no node,
// the gateway falls back to the SAME watch primitive directly (@farmslot/capabilities) so
// local branch tracking still works live — one implementation, node primary, gateway backup.
// A remote machine with no node degrades to the 60s poll (its files aren't on this host).
// Watches upgrade back to the node automatically when that machine's node connects.

import path from 'node:path';

import { type FileWatchHandle, watchFile } from '@farmslot/capabilities/fs-watch';

import { loadSlotVars, type SlotVars } from '../core/config.js';
import { execOnSlot, isLocal as checkIsLocal } from '../core/exec.js';
import { slotReadFile } from '../core/slot-io.js';
import { getNode } from '../fleet/machine-registry.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';
import { loadFleetStatus } from '../fleet/state.js';

export type BranchChangeHandler = (slotId: string, branch: string) => void;

interface BranchWatch {
  slotId: string;
  gitHeadPath: string;
  repoPath: string;
  isLocal: boolean;
  machine: string;
  host: string;
  sshTarget: string;
  lastBranch?: string;
  // Set only for the gateway-local fallback watch (local slot, no node). Stopped on unwatch.
  localWatch?: FileWatchHandle;
  // Set when the watch runs through the machine's node — the fs.watch request id, so
  // unwatch can send fs.watch.stop and the node doesn't leak the watcher (or double-watch
  // after a reconnect). Mirrors services/gateway/src/tasks/watcher.ts.
  nodeWatchRequestId?: string;
}

const activeWatches = new Map<string, BranchWatch>();
const handlers: BranchChangeHandler[] = [];

const DEBOUNCE_MS = 500;
const GIT_HEAD_TIMEOUT_MS = 5_000;
const REMOTE_POLL_MS = 60_000;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let remotePollInFlight = false;

// ─── Public API ───

export function onBranchChange(handler: BranchChangeHandler): void {
  handlers.push(handler);
}

function emit(slotId: string, branch: string): void {
  for (const h of handlers) h(slotId, branch);
}

// ─── Parse .git/HEAD content ───

export function parseBranch(content: string): string {
  const trimmed = content.trim();
  // Symbolic ref: "ref: refs/heads/my-branch"
  const match = trimmed.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (match) return match[1];
  // Detached HEAD: short SHA
  if (/^[0-9a-f]{7,40}$/.test(trimmed)) return trimmed.slice(0, 8);
  return trimmed || 'unknown';
}

export function normalizeGitHeadPath(repoPath: string, gitPath: string): string {
  const trimmed = gitPath.trim();
  if (!trimmed) return path.join(repoPath, '.git', 'HEAD');
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(repoPath, trimmed);
}

async function resolveGitHeadPath(repoPath: string, vars: SlotVars): Promise<string> {
  const result = await execOnSlot(
    vars,
    `git -C '${repoPath}' rev-parse --git-path HEAD 2>/dev/null`,
    { timeout: GIT_HEAD_TIMEOUT_MS },
  );
  return normalizeGitHeadPath(repoPath, result.stdout);
}

// ─── Watch a single slot's .git/HEAD ───

export async function watchBranch(slotId: string): Promise<void> {
  if (activeWatches.has(slotId)) return;

  const fleet = await loadFleetStatus();
  const slot = fleet.slots.find((s) => s.slot === slotId);
  if (!slot?.enabled) return;

  const vars = await loadSlotVars(slotId);
  const slotIsLocal = checkIsLocal(vars.host, vars.machine);
  const gitHeadPath = await resolveGitHeadPath(vars.remoteRepo, vars);

  const bw: BranchWatch = {
    slotId,
    gitHeadPath,
    repoPath: vars.remoteRepo,
    isLocal: slotIsLocal,
    machine: slot.machine,
    host: vars.host,
    sshTarget: vars.sshTarget,
    lastBranch: slot.branch || undefined,
  };

  // Prefer the machine's node — local and remote alike (ADR-046). Fallbacks when absent:
  //  • local slot  → the gateway watches the file directly via the shared primitive (backup).
  //  • remote slot → degraded to the 60s poll (the file lives on another host).
  // Either way it upgrades to the node's fs.watch when that machine's node connects
  // (node.connect → restartBranchWatchesForMachine).
  const node = getNode(slot.machine);
  if (node) {
    try {
      await sendNodeRequest(
        node,
        'fs.watch',
        { path: gitHeadPath },
        {
          onRequestId: (id) => {
            bw.nodeWatchRequestId = id;
          },
        },
      );
      console.log(`[branch-watcher] watching ${slotId} via node ${slot.machine}: ${gitHeadPath}`);
    } catch (err) {
      console.log(
        `[branch-watcher] failed to start watch for ${slotId}: ${(err as Error).message}`,
      );
    }
  } else if (slotIsLocal) {
    bw.localWatch = watchFile(gitHeadPath, (content) => debouncedUpdate(slotId, content));
    console.log(
      `[branch-watcher] no node for ${slot.machine} — gateway-local fallback watch for ${slotId}: ${gitHeadPath}`,
    );
  } else {
    console.log(
      `[branch-watcher] no node for remote ${slot.machine} — branch monitoring degraded (poll only) for ${slotId}`,
    );
  }

  activeWatches.set(slotId, bw);
  await readAndEmit(slotId);
}

// ─── Stop watching a slot ───

export async function unwatchBranch(slotId: string): Promise<void> {
  const bw = activeWatches.get(slotId);
  if (!bw) return;

  const timer = debounceTimers.get(slotId);
  if (timer) clearTimeout(timer);
  debounceTimers.delete(slotId);

  bw.localWatch?.stop();
  if (bw.nodeWatchRequestId) {
    // Tell the node to drop its fs.watch — otherwise it leaks the watcher and, after a
    // reconnect, would double-watch. Best-effort: if the node is gone the watch dies with it.
    const node = getNode(bw.machine);
    if (node) {
      void sendNodeRequest(node, 'fs.watch.stop', { requestId: bw.nodeWatchRequestId }).catch(
        (err: unknown) => {
          console.log(
            `[branch-watcher] fs.watch.stop failed for ${slotId}: ${(err as Error).message}`,
          );
        },
      );
    }
  }
  activeWatches.delete(slotId);
  console.log(`[branch-watcher] stopped watching ${slotId}`);
}

// ─── Handle remote agent fs.changed events for .git/HEAD ───

export function handleBranchFsChanged(payload: {
  machine: string;
  path: string;
  content: string;
}): boolean {
  for (const [slotId, bw] of activeWatches) {
    if (bw.machine === payload.machine && bw.gitHeadPath === payload.path) {
      debouncedUpdate(slotId, payload.content);
      return true;
    }
  }
  return false;
}

// ─── Debounced branch update ───

function debouncedUpdate(slotId: string, content?: string): void {
  const existing = debounceTimers.get(slotId);
  if (existing) clearTimeout(existing);

  debounceTimers.set(
    slotId,
    setTimeout(async () => {
      debounceTimers.delete(slotId);
      await readAndEmit(slotId, content);
    }, DEBOUNCE_MS),
  );
}

async function readAndEmit(slotId: string, content?: string): Promise<void> {
  const bw = activeWatches.get(slotId);
  if (!bw) return;

  try {
    let branch = '';
    const vars = await loadSlotVars(slotId);
    const gitResult = await execOnSlot(
      vars,
      `git -C '${bw.repoPath}' symbolic-ref --short HEAD 2>/dev/null || git -C '${bw.repoPath}' rev-parse --short HEAD 2>/dev/null`,
      { timeout: GIT_HEAD_TIMEOUT_MS },
    );
    branch = gitResult.stdout.trim();
    if (!branch) {
      const raw = content ?? (await slotReadFile(bw, bw.gitHeadPath));
      branch = parseBranch(raw);
    }
    if (branch === bw.lastBranch) return;
    bw.lastBranch = branch;
    emit(slotId, branch);
  } catch (err) {
    console.log(`[branch-watcher] error reading ${slotId}: ${(err as Error).message}`);
  }
}

// ─── Start watchers for all enabled slots ───

export async function startBranchWatchers(): Promise<void> {
  const fleet = await loadFleetStatus();
  for (const slot of fleet.slots) {
    if (slot.enabled) {
      try {
        await watchBranch(slot.slot);
      } catch (err) {
        console.warn(`[branch-watcher] skipping ${slot.slot}: ${(err as Error).message}`);
      }
    }
  }
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      void pollRemoteBranches();
    }, REMOTE_POLL_MS);
    pollTimer.unref();
  }
}

async function pollRemoteBranches(): Promise<void> {
  if (remotePollInFlight) return;
  remotePollInFlight = true;
  try {
    // Poll every registered watch (local + remote) — a fallback refresh in case a node
    // fs.changed event was missed or the machine's node is not connected.
    for (const slotId of activeWatches.keys()) {
      await readAndEmit(slotId);
    }
  } finally {
    remotePollInFlight = false;
  }
}

export async function restartBranchWatchesForMachine(machine: string): Promise<void> {
  const fleet = await loadFleetStatus();
  for (const slot of fleet.slots) {
    if (!slot.enabled || slot.machine !== machine) continue;
    const existing = activeWatches.get(slot.slot);
    if (existing) {
      await unwatchBranch(slot.slot);
    }
    try {
      await watchBranch(slot.slot);
    } catch (err) {
      console.warn(`[branch-watcher] restart failed for ${slot.slot}: ${(err as Error).message}`);
    }
  }
}

// ─── Stop all watches ───

export async function stopAllBranchWatches(): Promise<void> {
  for (const slotId of Array.from(activeWatches.keys())) {
    await unwatchBranch(slotId);
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
