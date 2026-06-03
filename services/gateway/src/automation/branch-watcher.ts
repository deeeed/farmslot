// branch-watcher.ts — Watches .git/HEAD for all enabled slots, broadcasts branch changes.
// Local slots: chokidar file watch.
// Remote slots: agent fs.watch via WS.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { type FSWatcher, watch } from 'chokidar';

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
  watcher?: FSWatcher;
  lastBranch?: string;
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

  if (slotIsLocal) {
    if (!existsSync(gitHeadPath)) {
      console.log(`[branch-watcher] .git/HEAD not found at ${gitHeadPath} — skipping`);
      return;
    }

    const bw: BranchWatch = {
      slotId,
      gitHeadPath,
      repoPath: vars.remoteRepo,
      isLocal: true,
      machine: slot.machine,
      host: vars.host,
      sshTarget: vars.sshTarget,
      lastBranch: slot.branch || undefined,
    };

    const chokidarWatcher = watch(gitHeadPath, { persistent: false, ignoreInitial: true });
    chokidarWatcher.on('change', () => debouncedUpdate(slotId));
    bw.watcher = chokidarWatcher;

    activeWatches.set(slotId, bw);
    await readAndEmit(slotId);
    console.log(`[branch-watcher] watching local ${slotId}: ${gitHeadPath}`);
  } else {
    const node = getNode(slot.machine);
    if (!node) {
      console.log(`[branch-watcher] no node for ${slot.machine} — skipping remote watch`);
      return;
    }

    try {
      await sendNodeRequest(node, 'fs.watch', { path: gitHeadPath });
      const bw: BranchWatch = {
        slotId,
        gitHeadPath,
        repoPath: vars.remoteRepo,
        isLocal: false,
        machine: slot.machine,
        host: vars.host,
        sshTarget: vars.sshTarget,
        lastBranch: slot.branch || undefined,
      };
      activeWatches.set(slotId, bw);
      await readAndEmit(slotId);
      console.log(
        `[branch-watcher] watching remote ${slotId} via node ${slot.machine}: ${gitHeadPath}`,
      );
    } catch (err) {
      console.log(
        `[branch-watcher] failed to start remote watch for ${slotId}: ${(err as Error).message}`,
      );
    }
  }
}

// ─── Stop watching a slot ───

export async function unwatchBranch(slotId: string): Promise<void> {
  const bw = activeWatches.get(slotId);
  if (!bw) return;

  if (bw.watcher) {
    await bw.watcher.close();
  }

  const timer = debounceTimers.get(slotId);
  if (timer) clearTimeout(timer);
  debounceTimers.delete(slotId);

  activeWatches.delete(slotId);
  console.log(`[branch-watcher] stopped watching ${slotId}`);
}

// ─── Handle remote agent fs.changed events for .git/HEAD ───

export function handleBranchFsChanged(payload: {
  machine: string;
  path: string;
  content: string;
}): void {
  for (const [slotId, bw] of activeWatches) {
    if (!bw.isLocal && bw.machine === payload.machine && bw.gitHeadPath === payload.path) {
      debouncedUpdate(slotId, payload.content);
      return;
    }
  }
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
    for (const [slotId, bw] of activeWatches) {
      if (bw.isLocal) continue;
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
    if (existing && existing.isLocal) continue;
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
