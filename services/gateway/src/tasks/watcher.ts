// task-watcher.ts — Watches TASK.md for working slots, broadcasts progress updates.
// Local slots: chokidar file watch.
// Remote slots: agent fs.watch via WS.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { type FSWatcher, watch } from 'chokidar';

import type {
  AgentContext,
  AgentRole,
  TaskProgressResult,
  WorkerSignal,
} from '@farmslot/protocol';

import { getAgentContexts, summarizeAgentContexts } from '../agents/contexts.js';
import {
  selectSingleActiveRunForSlot,
  SKIP_ACTIVE_RUN_SELECTION,
} from '../core/active-run-selection.js';
import { resolveTaskPaths } from '../core/config.js';
import { isLocal } from '../core/exec.js';
import { slotReadFile } from '../core/slot-io.js';
import { updateSlotStatus } from '../core/state.js';
import { getNode } from '../fleet/machine-registry.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';
import { clearTaskProgressOverlay, loadFleetStatus } from '../fleet/state.js';
import { progressFingerprint, taskProgress } from '../methods/task.js';
import { listRuns } from '../runs/store.js';

import { normalizeWorkerSignal } from './worker-signals.js';

export type TaskProgressHandler = (
  slotId: string,
  progress: TaskProgressResult,
  role?: AgentRole,
  contextId?: string,
  runId?: string | null,
) => void;
export type WorkerSignalHandler = (
  slotId: string,
  runId: string | null,
  signal: WorkerSignal,
  role?: AgentRole,
  contextId?: string,
) => void;

interface SlotWatch {
  slotId: string;
  taskFilePath: string;
  signalFilePath: string; // SIGNAL.json in same directory
  runId: string | null; // associated run ID (for signal events)
  role?: AgentRole;
  contextId?: string;
  isLocal: boolean;
  machine: string;
  host: string;
  sshTarget: string;
  watcher?: FSWatcher; // chokidar watcher for local (TASK.md)
  signalWatcher?: FSWatcher; // chokidar watcher for local (SIGNAL.json)
  agentRequestIds?: Array<{ requestId: string; kind: 'task' | 'signal' }>; // fs.watch request IDs for remote task + signal watches
  lastProgressFingerprint?: string; // debounce: only emit when progress inputs actually change
}

interface WatchSlotOptions {
  runId?: string;
  contexts?: AgentContext[];
}

const activeWatches = new Map<string, SlotWatch>();
const pendingWatchKeys = new Map<string, Promise<void>>();
const handlers: TaskProgressHandler[] = [];
const signalHandlers: WorkerSignalHandler[] = [];

// Debounce interval — don't re-parse on every keystroke
const DEBOUNCE_MS = 1000;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function watchKey(slotId: string, contextId?: string): string {
  if (slotId.includes(':')) {
    throw new Error(`Invalid slot id for watch key: '${slotId}' contains ':'`);
  }
  return `${slotId}:${contextId ?? 'primary'}`;
}

export function slotIdFromWatchKey(key: string): string {
  const separator = key.indexOf(':');
  return separator === -1 ? key : key.slice(0, separator);
}

function isSubpath(root: string, candidate: string): boolean {
  const normalizedRoot = path.posix.normalize(root).replace(/\/+$/, '');
  const normalizedCandidate = path.posix.normalize(candidate);
  return (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

export function resolveContextFilePath(
  remoteRepo: string,
  filePath: string | null | undefined,
  fallback: string,
  siblingOf?: string,
): string {
  if (!filePath) return fallback;
  if (!remoteRepo) {
    // Without a known repo root, isSubpath collapses to '.' and lexical-escape
    // checks become meaningless. Refuse to validate the path rather than
    // silently accepting an orchestrator-absolute or escaping path.
    throw new Error(`Cannot resolve context file path '${filePath}' without a remote repo root`);
  }
  const normalizedRepo = path.posix.normalize(remoteRepo).replace(/\/+$/, '');
  const normalized = path.posix.normalize(filePath);
  if (path.posix.isAbsolute(filePath)) {
    if (!isSubpath(normalizedRepo, normalized))
      throw new Error(`Context file path escapes repo: ${filePath}`);
    return normalized;
  }
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Context file path escapes repo: ${filePath}`);
  }
  if (!filePath.includes('/')) {
    if (siblingOf) {
      const siblingPath = path.posix.join(path.posix.dirname(siblingOf), normalized);
      if (!isSubpath(normalizedRepo, siblingPath))
        throw new Error(`Context sibling path escapes repo: ${filePath}`);
      return siblingPath;
    }
    return fallback;
  }
  const joined = path.posix.join(normalizedRepo, normalized);
  if (!isSubpath(normalizedRepo, joined))
    throw new Error(`Context file path escapes repo: ${filePath}`);
  return joined;
}

export function onTaskProgress(handler: TaskProgressHandler): void {
  handlers.push(handler);
}

export function onWorkerSignal(handler: WorkerSignalHandler): () => void {
  signalHandlers.push(handler);
  return () => {
    const idx = signalHandlers.indexOf(handler);
    if (idx >= 0) signalHandlers.splice(idx, 1);
  };
}

function emit(
  slotId: string,
  progress: TaskProgressResult,
  role?: AgentRole,
  contextId?: string,
  runId?: string | null,
): void {
  for (const h of handlers) h(slotId, progress, role, contextId, runId);
}

function emitSignal(
  slotId: string,
  runId: string | null,
  signal: WorkerSignal,
  role?: AgentRole,
  contextId?: string,
): void {
  for (const h of signalHandlers) h(slotId, runId, signal, role, contextId);
}

export function shouldRebindWatch(
  current: Pick<SlotWatch, 'runId' | 'taskFilePath' | 'signalFilePath'> | undefined,
  next: Pick<SlotWatch, 'runId' | 'taskFilePath' | 'signalFilePath'>,
): boolean {
  return (
    !!current &&
    (current.runId !== next.runId ||
      current.taskFilePath !== next.taskFilePath ||
      current.signalFilePath !== next.signalFilePath)
  );
}

function resolveActiveRunForWatch(
  slotId: string,
  activeRuns: ReturnType<typeof listRuns>['runs'],
  currentRunId?: string | null,
  requestedRunId?: string,
): ReturnType<typeof listRuns>['runs'][number] | null | undefined {
  // Watch lifecycle: missing pointer or genuine ambiguity must SKIP (return
  // undefined) so we do not start a watch under an uncertain identity. The
  // shared helper returns SKIP_ACTIVE_RUN_SELECTION for that case; map it to
  // undefined to preserve the watch-skip contract this function exposes.
  const result = selectSingleActiveRunForSlot(slotId, activeRuns, {
    requestedRunId: requestedRunId ?? null,
    currentRunId,
    onAmbiguous: 'warn-skip',
    onMissingPointer: 'warn-skip',
    logPrefix: '[task-watcher]',
  });
  if (result === SKIP_ACTIVE_RUN_SELECTION) return undefined;
  return result;
}

// ─── Start watching a slot's TASK.md ───

export async function watchSlot(
  slotId: string,
  runIdOrOptions?: string | WatchSlotOptions,
): Promise<void> {
  const options: WatchSlotOptions =
    typeof runIdOrOptions === 'string' ? { runId: runIdOrOptions } : (runIdOrOptions ?? {});
  const fleet = await loadFleetStatus();
  const slot = fleet.slots.find((s) => s.slot === slotId);
  if (!slot?.taskFile) return;

  // Resolve paths (same for local and remote)
  const { vars, taskMdPath, signalPath } = await resolveTaskPaths(slotId, slot.taskFile);
  const slotIsLocal = isLocal(vars.host, vars.machine);
  const activeRunList = listRuns({ active: true }).runs;
  const activeRun = resolveActiveRunForWatch(
    slotId,
    activeRunList,
    slot.currentRunId,
    options.runId,
  );
  if (activeRun === undefined) {
    // Ambiguous selection: tear down any existing watches for this slot rather
    // than leaving a stale one emitting events tagged with the wrong runId.
    await unwatchSlot(slotId);
    return;
  }
  const contexts = options.contexts ?? (activeRun ? getAgentContexts(activeRun) : []);
  const legacyPrimaryWatch = activeWatches.get(watchKey(slotId));
  if (contexts.length > 0 && legacyPrimaryWatch && !legacyPrimaryWatch.contextId) {
    await unwatchKey(watchKey(slotId));
  }
  const watchContexts: Array<AgentContext | null> = contexts.length > 0 ? contexts : [null];

  for (const context of watchContexts) {
    const key = watchKey(slotId, context?.id);
    const contextTaskPath = resolveContextFilePath(vars.remoteRepo, context?.taskFile, taskMdPath);
    const contextSignalPath = resolveContextFilePath(
      vars.remoteRepo,
      context?.signalFile,
      signalPath,
      contextTaskPath,
    );
    const runId = options.runId ?? context?.runId ?? activeRun?.id ?? null;
    const existingWatch = activeWatches.get(key);
    const nextWatchIdentity = {
      runId,
      taskFilePath: contextTaskPath,
      signalFilePath: contextSignalPath,
    };
    if (existingWatch && !shouldRebindWatch(existingWatch, nextWatchIdentity)) {
      continue;
    }
    if (existingWatch) {
      await unwatchKey(key);
    } else {
      const pendingWatch = pendingWatchKeys.get(key);
      if (pendingWatch) {
        await pendingWatch;
        const pendingResult = activeWatches.get(key);
        if (pendingResult && !shouldRebindWatch(pendingResult, nextWatchIdentity)) {
          continue;
        }
        if (pendingResult) await unwatchKey(key);
      }
    }

    const startWatch: Promise<void> = (async () => {
      const sw: SlotWatch = {
        slotId,
        taskFilePath: contextTaskPath,
        signalFilePath: contextSignalPath,
        runId,
        role: context?.role,
        contextId: context?.id,
        isLocal: slotIsLocal,
        machine: slot.machine,
        host: vars.host,
        sshTarget: vars.sshTarget,
      };

      if (slotIsLocal) {
        if (!existsSync(contextTaskPath)) {
          console.log(
            `[task-watcher] task file not found for ${key} at ${contextTaskPath} — skipping watch`,
          );
          return;
        }

        // Watch task markdown with chokidar
        const chokidarWatcher = watch(contextTaskPath, { persistent: false, ignoreInitial: true });
        chokidarWatcher.on('change', () => debouncedUpdate(key));
        sw.watcher = chokidarWatcher;

        // Watch signal with chokidar (watches for creation + changes)
        const signalWatcher = watch(contextSignalPath, { persistent: false, ignoreInitial: false });
        signalWatcher.on('add', () => handleSignalChange(key));
        signalWatcher.on('change', () => handleSignalChange(key));
        sw.signalWatcher = signalWatcher;

        activeWatches.set(key, sw);
        console.log(
          `[task-watcher] watching local ${key}: ${contextTaskPath} + ${contextSignalPath}`,
        );
      } else {
        // Remote slot — use node fs.watch
        const node = getNode(slot.machine);
        if (!node) {
          console.log(`[task-watcher] no node for ${slot.machine} — skipping remote watch`);
          return;
        }

        try {
          const requestIds: Array<{ requestId: string; kind: 'task' | 'signal' }> = [];
          (await sendNodeRequest(
            node,
            'fs.watch',
            { path: contextTaskPath },
            { onRequestId: (id) => requestIds.push({ requestId: id, kind: 'task' }) },
          )) as { watching: boolean };
          try {
            (await sendNodeRequest(
              node,
              'fs.watch',
              { path: contextSignalPath },
              { onRequestId: (id) => requestIds.push({ requestId: id, kind: 'signal' }) },
            )) as { watching: boolean };
          } catch (err) {
            console.log(
              `[task-watcher] signal file not yet present for remote ${key}: ${(err as Error).message}`,
            );
          }
          sw.agentRequestIds = requestIds;
          activeWatches.set(key, sw);
          console.log(
            `[task-watcher] watching remote ${key} via node ${slot.machine}: ${contextTaskPath} + ${contextSignalPath}`,
          );
        } catch (err) {
          console.log(
            `[task-watcher] failed to start remote watch for ${key}: ${(err as Error).message}`,
          );
        }
      }
    })();

    // Set pending BEFORE awaiting to prevent concurrent watchSlot calls from
    // spawning duplicate watches for the same key.
    pendingWatchKeys.set(key, startWatch);
    try {
      await startWatch;
    } catch (err) {
      console.warn(
        `[task-watcher] invalid context watch path for ${key}: ${(err as Error).message}`,
      );
    } finally {
      if (pendingWatchKeys.get(key) === startWatch) pendingWatchKeys.delete(key);
    }
  }
}

export async function watchContext(slotId: string, context: AgentContext): Promise<void> {
  await watchSlot(slotId, { runId: context.runId, contexts: [context] });
}

// ─── Stop watching a slot ───

export async function unwatchSlot(slotId: string): Promise<void> {
  // Drain pending watches first so they don't complete after unwatch
  for (const [key, pending] of pendingWatchKeys) {
    if (slotIdFromWatchKey(key) === slotId) {
      try {
        await pending;
      } catch (err) {
        console.warn(
          `[task-watcher] pending watch setup failed while unwatching ${key}: ${(err as Error).message}`,
        );
      }
    }
  }
  const keys = [...activeWatches.keys()].filter((key) => slotIdFromWatchKey(key) === slotId);
  for (const key of keys) {
    await unwatchKey(key);
  }
  clearTaskProgressOverlay(slotId);
  console.log(`[task-watcher] stopped watching ${slotId}`);
}

export async function unwatchContext(slotId: string, contextId: string): Promise<void> {
  await unwatchKey(watchKey(slotId, contextId));
  console.log(`[task-watcher] stopped watching ${slotId}:${contextId}`);
}

async function unwatchKey(key: string): Promise<void> {
  const sw = activeWatches.get(key);
  if (!sw) return;

  if (sw.watcher) {
    await sw.watcher.close();
  }
  if (sw.signalWatcher) {
    await sw.signalWatcher.close();
  }

  if (!sw.isLocal && sw.agentRequestIds?.length) {
    const fleet = await loadFleetStatus();
    const slot = fleet.slots.find((s) => s.slot === sw.slotId);
    if (slot) {
      const node = getNode(slot.machine);
      if (node) {
        await Promise.all(
          sw.agentRequestIds.map(async ({ requestId }) => {
            try {
              await sendNodeRequest(node, 'fs.watch.stop', { requestId });
            } catch (err) {
              console.warn(
                `[task-watcher] failed to stop remote watch ${requestId}: ${(err as Error).message}`,
              );
            }
          }),
        );
      }
    }
  }

  const timer = debounceTimers.get(key);
  if (timer) clearTimeout(timer);
  debounceTimers.delete(key);

  activeWatches.delete(key);
}

// ─── Handle remote agent fs.changed events ───

export function handleAgentFsChanged(payload: {
  requestId: string;
  machine: string;
  path: string;
  content: string;
}): void {
  for (const [key, sw] of activeWatches) {
    if (sw.isLocal || sw.machine !== payload.machine) continue;
    const request = sw.agentRequestIds?.find((entry) => entry.requestId === payload.requestId);
    if (!request) continue;
    if (request.kind === 'task') {
      if (payload.path !== sw.taskFilePath) {
        console.warn(
          `[task-watcher] ignoring task watch path mismatch for ${key}: request=${payload.requestId} path=${payload.path}`,
        );
        return;
      }
      debouncedUpdate(key, payload.content);
      return;
    }
    if (payload.path !== sw.signalFilePath) {
      console.warn(
        `[task-watcher] ignoring signal watch path mismatch for ${key}: request=${payload.requestId} path=${payload.path}`,
      );
      return;
    }
    void handleSignalChange(key, payload.content);
    return;
  }

  console.warn(
    `[task-watcher] ignoring fs.changed ${payload.requestId} for ${payload.machine}:${payload.path}; no active watch owns that request id`,
  );
}

// ─── Debounced progress update ───

function debouncedUpdate(key: string, content?: string): void {
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);

  debounceTimers.set(
    key,
    setTimeout(async () => {
      debounceTimers.delete(key);
      await computeAndEmit(key, content);
    }, DEBOUNCE_MS),
  );
}

async function computeAndEmit(key: string, content?: string): Promise<void> {
  const sw = activeWatches.get(key);
  if (!sw) return;

  try {
    // Read fresh content if not provided
    let markdown = content;
    if (!markdown) {
      markdown = await slotReadFile(sw, sw.taskFilePath);
    }

    const signal = await readSignalForFingerprint(sw);
    const fingerprint = progressFingerprint(markdown, signal);
    if (fingerprint === sw.lastProgressFingerprint) return;
    sw.lastProgressFingerprint = fingerprint;

    // Use the existing taskProgress method to get structured progress
    const result = await taskProgress({
      slotId: sw.slotId,
      runId: sw.runId ?? undefined,
      role: sw.role,
      contextId: sw.contextId,
    });
    emit(sw.slotId, result, sw.role, sw.contextId, sw.runId);
  } catch (err) {
    // File may have been deleted (slot released)
    console.log(`[task-watcher] error reading ${key}: ${(err as Error).message}`);
  }
}

async function readSignalForFingerprint(sw: SlotWatch): Promise<WorkerSignal | null> {
  try {
    const json = await slotReadFile(sw, sw.signalFilePath);
    const parsed = JSON.parse(json) as WorkerSignal;
    const normalized = normalizeWorkerSignal(parsed);
    return normalized.ok ? normalized.signal : null;
  } catch {
    // SIGNAL.json is optional and often absent until the worker writes its
    // first signal. Fingerprinting should still proceed from TASK.md alone.
    return null;
  }
}

// ─── Handle SIGNAL.json changes ───

export function bindWorkerSignalToWatch(
  key: string,
  signal: WorkerSignal,
  role?: AgentRole,
  contextId?: string,
): { signal: WorkerSignal; role?: AgentRole; contextId?: string } | null {
  if (role && signal.role && signal.role !== role) {
    console.warn(
      `[task-watcher] ignoring signal role mismatch for ${key}: file=${signal.role} watch=${role}`,
    );
    return null;
  }
  if (contextId && signal.contextId && signal.contextId !== contextId) {
    console.warn(
      `[task-watcher] ignoring signal context mismatch for ${key}: file=${signal.contextId} watch=${contextId}`,
    );
    return null;
  }
  const boundRole = role ?? signal.role;
  const boundContextId = contextId ?? signal.contextId;
  return {
    signal: { ...signal, role: boundRole, contextId: boundContextId },
    role: boundRole,
    contextId: boundContextId,
  };
}

async function handleSignalChange(key: string, content?: string): Promise<void> {
  const sw = activeWatches.get(key);
  if (!sw) return;

  try {
    let json = content;
    if (!json) {
      json = await slotReadFile(sw, sw.signalFilePath);
    }

    const rawSignal = JSON.parse(json) as WorkerSignal;
    const normalized = normalizeWorkerSignal(rawSignal);
    if (!normalized.ok) {
      console.log(`[task-watcher] invalid signal file for ${key} — ${normalized.reason}`);
      return;
    }
    const signal = normalized.signal;
    if (signal !== rawSignal) {
      console.warn(
        `[task-watcher] normalized signal for ${key}: ${signal.reason ?? 'invalid no-change signal'}`,
      );
    }
    const bound = bindWorkerSignalToWatch(key, signal, sw.role, sw.contextId);
    if (!bound) return;

    // Basic validation
    if (!signal.status) {
      console.log(`[task-watcher] invalid signal file for ${key} — missing status`);
      return;
    }

    console.log(
      `[task-watcher] signal from ${key}: role=${bound.role ?? '-'} status=${signal.status} outcome=${signal.outcome ?? '-'} step=${signal.step ?? '-'}`,
    );
    emitSignal(sw.slotId, sw.runId, bound.signal, bound.role, bound.contextId);
    await computeAndEmit(key);
  } catch (err) {
    console.log(`[task-watcher] error reading signal file for ${key}: ${(err as Error).message}`);
  }
}

// ─── Scan fleet for working slots and start watching ───

export async function startWatchingActiveSlots(): Promise<void> {
  const fleet = await loadFleetStatus();
  for (const run of listRuns({ active: true }).runs) {
    if (run.slotId && run.agentContexts?.length) {
      await updateSlotStatus(run.slotId, { agent_contexts: summarizeAgentContexts(run) });
    }
  }
  for (const slot of fleet.slots) {
    const hasActiveWorkerTask =
      slot.lifecycle === 'busy' || (slot.lifecycle === 'held' && slot.phase === 'ci-watch');
    if (hasActiveWorkerTask && slot.taskFile) {
      try {
        await watchSlot(slot.slot, slot.currentRunId ? { runId: slot.currentRunId } : undefined);
      } catch (err) {
        // Recovery scan must not abort on a single bad slot: watchKey throws on
        // colon-bearing slot ids, and any other watch-setup failure should be
        // surfaced and skipped so the rest of the fleet still gets watched.
        // Escalated to console.error (not warn) so operators see the slot is
        // unwatched and any worker signal updates for it will be missed until
        // the next dispatch reinitializes the watch.
        console.error(
          `[task-watcher] failed to start watch for ${slot.slot} (slot will not receive task progress events until next dispatch): ${(err as Error).message}`,
        );
      }
    }
  }
}

// ─── Stop all watches ───

export async function stopAllWatches(): Promise<void> {
  const slotIds = new Set(Array.from(activeWatches.keys(), slotIdFromWatchKey));
  for (const slotId of slotIds) {
    await unwatchSlot(slotId);
  }
}
