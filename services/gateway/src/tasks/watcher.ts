// task-watcher.ts — Watches TASK.md for working slots, broadcasts progress updates.
// Local slots: chokidar file watch.
// Remote slots: agent fs.watch via WS.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { type FSWatcher, watch } from 'chokidar';

import type { AgentContext, AgentRole, TaskProgressResult, WorkerSignal } from '@farmslot/protocol';

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
import { taskProgress } from '../methods/task.js';
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
  lastCheckboxHash?: string; // debounce: only emit when checkboxes actually change
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

export function emitWorkerSignal(
  slotId: string,
  runId: string | null,
  signal: WorkerSignal,
  role?: AgentRole,
  contextId?: string,
): void {
  // Iterate a snapshot: a handler may unsubscribe during dispatch (handoff
  // watchers disarm inline), and splicing the live array would skip the next
  // registered handler for this event.
  for (const h of [...signalHandlers]) h(slotId, runId, signal, role, contextId);
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
    // Fast path: identical live watch with no rebind in flight — nothing to
    // do. With one in flight the live entry may be about to change, so the
    // authoritative check happens inside the chained promise below.
    if (
      existingWatch &&
      !pendingWatchKeys.has(key) &&
      !shouldRebindWatch(existingWatch, nextWatchIdentity)
    ) {
      continue;
    }

    const priorRebind = pendingWatchKeys.get(key);
    const startWatch: Promise<void> = (async () => {
      // Per-key serialization: every rebind chains behind the in-flight one
      // and re-reads the live entry only after it settles. Concurrent rebinds
      // previously captured the same stale watch, overwrote each other's
      // pending entry, and leaked the loser's watchers with no registry entry
      // for unwatchSlot to find. Registering the chained promise in
      // pendingWatchKeys (below) also keeps unwatchSlot's pending drain
      // covering the WHOLE chain — including this rebind's stale-watch
      // teardown — so the overlay clear cannot land in the
      // teardown-vs-registration gap.
      if (priorRebind) {
        try {
          await priorRebind;
        } catch {
          // The prior rebind's failure is reported at its own await site;
          // this rebind only needs it settled before reading the map.
        }
      }
      const staleWatch = activeWatches.get(key);
      if (staleWatch && !shouldRebindWatch(staleWatch, nextWatchIdentity)) return;
      if (staleWatch) {
        // Raw teardown: this code IS the chained operation for this key —
        // the chain-aware unwatchKey would await its own promise.
        await closeWatchEntry(key, { expected: staleWatch });
      }
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

export async function unwatchSlot(
  slotId: string,
  opts?: { expectedRunId?: string },
): Promise<void> {
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
  // Owner-scoped removal (see unwatchContext): a caller undoing only its own
  // wiring must never strip watches a successor run registered since. The
  // entry is captured here and identity-checked inside unwatchKey so a
  // replacement landing mid-close is never torn down.
  const targets = [...activeWatches.entries()].filter(
    ([key, sw]) =>
      slotIdFromWatchKey(key) === slotId &&
      (!opts?.expectedRunId || sw.runId === opts.expectedRunId),
  );
  for (const [key, sw] of targets) {
    await unwatchKey(key, { expected: sw, expectedRunId: opts?.expectedRunId });
  }
  // Overlay decision from a POST-teardown recheck — a pre-teardown snapshot
  // would miss watches registered while the closes above were awaited.
  const anyRemaining = [...activeWatches.keys()].some((key) => slotIdFromWatchKey(key) === slotId);
  if (!anyRemaining) {
    clearTaskProgressOverlay(slotId);
  }
  console.log(`[task-watcher] stopped watching ${slotId}`);
}

export async function unwatchContext(
  slotId: string,
  contextId: string,
  opts?: { expectedRunId?: string },
): Promise<void> {
  const key = watchKey(slotId, contextId);
  if (opts?.expectedRunId) {
    const sw = activeWatches.get(key);
    // Context IDs are role-based and reused across runs: a successor may have
    // re-registered this key already, and removing its watch would strip the
    // new owner's observability. Owner-scoped removal only — the matched
    // entry is passed through so unwatchKey's identity guard also covers a
    // replacement landing between this check and the teardown.
    if (sw && sw.runId !== opts.expectedRunId) {
      console.log(
        `[task-watcher] skip unwatch ${slotId}:${contextId} — watch now belongs to run ${sw.runId ?? 'unknown'}`,
      );
      return;
    }
    // The owner scope travels INTO the chained teardown: when the entry is
    // temporarily absent mid-rebind, a pre-chain snapshot alone would chain
    // behind the rebind and close the successor it registers.
    await unwatchKey(key, { expected: sw ?? undefined, expectedRunId: opts.expectedRunId });
  } else {
    await unwatchKey(key);
  }
  console.log(`[task-watcher] stopped watching ${slotId}:${contextId}`);
}

/**
 * Chain-aware teardown for external callers: registers itself in
 * pendingWatchKeys behind whatever operation is in flight, so a concurrent
 * watchSlot can neither fast-path past a mid-close teardown (it would observe
 * the still-active entry, skip registering, and end up with no watch once the
 * delete lands) nor interleave its rebind with one. Code already running
 * INSIDE a chained operation must call closeWatchEntry directly — chaining
 * from within the chain would await itself.
 */
async function unwatchKey(key: string, opts?: UnwatchGuardOpts): Promise<void> {
  const prior = pendingWatchKeys.get(key);
  const teardown: Promise<void> = (async () => {
    if (prior) {
      try {
        await prior;
      } catch {
        // The prior operation's failure is reported at its own await site;
        // this teardown only needs it settled before touching the entry.
      }
    }
    await closeWatchEntry(key, opts);
  })();
  pendingWatchKeys.set(key, teardown);
  try {
    await teardown;
  } finally {
    if (pendingWatchKeys.get(key) === teardown) pendingWatchKeys.delete(key);
  }
}

interface UnwatchGuardOpts {
  /**
   * Exact entry the caller intends to tear down (identity guard). Consulted
   * ONLY when no owner scope is given — see closeWatchEntry.
   */
  expected?: SlotWatch;
  /**
   * Owner scope, authoritative when present and re-checked HERE against the
   * LIVE entry after any chained prior operation settled: the caller is
   * undoing ALL wiring for that run, so a same-run replacement installed
   * mid-chain must still be torn down; only a foreign run's entry survives.
   */
  expectedRunId?: string;
}

async function closeWatchEntry(key: string, opts?: UnwatchGuardOpts): Promise<void> {
  const sw = activeWatches.get(key);
  if (!sw) return;
  if (opts?.expectedRunId) {
    // Owner scope decides alone — letting the exact-entry guard veto here
    // would skip a same-run replacement installed mid-chain and leave the
    // losing run's wiring alive.
    if (sw.runId !== opts.expectedRunId) {
      console.log(
        `[task-watcher] skip unwatch ${key} — watch now belongs to run ${sw.runId ?? 'unknown'}`,
      );
      return;
    }
  } else if (opts?.expected && sw !== opts.expected) {
    // Identity guard for in-chain rebind cleanup: a successor may have
    // replaced this key's entry — closing the CURRENT entry would tear down
    // the successor's live watch.
    return;
  }

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

  // Same identity guard after the awaited closes: only remove what THIS call
  // actually tore down — a successor re-registered mid-close owns the current
  // entry and timer.
  if (activeWatches.get(key) === sw) {
    const timer = debounceTimers.get(key);
    if (timer) clearTimeout(timer);
    debounceTimers.delete(key);
    activeWatches.delete(key);
  }
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

    // Quick hash of checkbox states to avoid redundant broadcasts
    const checkboxHash = hashCheckboxes(markdown);
    if (checkboxHash === sw.lastCheckboxHash) return;
    sw.lastCheckboxHash = checkboxHash;

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

function hashCheckboxes(markdown: string): string {
  // Fast: just concat checkbox states as a string
  let hash = '';
  for (const line of markdown.split('\n')) {
    const t = line.trim();
    if (t.startsWith('- [x]') || t.startsWith('- [X]')) hash += '1';
    else if (t.startsWith('- [ ]')) hash += '0';
  }
  return hash;
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
    emitWorkerSignal(sw.slotId, sw.runId, bound.signal, bound.role, bound.contextId);
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
