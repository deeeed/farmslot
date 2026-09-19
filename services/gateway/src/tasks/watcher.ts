// task-watcher.ts — Watches TASK.md for working slots, broadcasts progress updates.
// Local slots: chokidar file watch.
// Remote slots: agent fs.watch via WS.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { type FSWatcher, watch } from 'chokidar';

import {
  type AgentContext,
  type AgentRole,
  SUBTASK_INDEX_FILE,
  type SubtaskIndex,
  type SubtaskIndexUnit,
  type TaskProgressResult,
  type WorkerSignal,
} from '@farmslot/protocol';

import { getAgentContexts, summarizeAgentContexts } from '../agents/contexts.js';
import {
  selectSingleActiveRunForSlot,
  SKIP_ACTIVE_RUN_SELECTION,
} from '../core/active-run-selection.js';
import { resolveTaskPaths } from '../core/config.js';
import { isLocal } from '../core/exec.js';
import { slotFileExists, slotMkdir, slotReadFile } from '../core/slot-io.js';
import { updateSlotStatus } from '../core/state.js';
import { getNode } from '../fleet/machine-registry.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';
import { clearTaskProgressOverlay, loadFleetStatus } from '../fleet/state.js';
import { taskProgress } from '../methods/task.js';
import { listRuns } from '../runs/store.js';

import {
  resolveTaskProgressMarkdownPath,
  resolveTaskProgressMarkdownPathForSlot,
} from './progress-path.js';
import { WORKER_MIRROR_SUFFIX } from './sidecars.js';
import {
  parseSubtaskIndex,
  readSubtaskIndex,
  subtaskIndexPathFor,
  subtasksDirFor,
  subtaskUnitsForParentChecklist,
} from './subtasks.js';
import { normalizeWorkerSignal } from './worker-signals.js';

export type TaskProgressHandler = (
  slotId: string,
  progress: TaskProgressResult,
  role?: AgentRole,
  contextId?: string,
  runId?: string | null,
  /**
   * Set only when a child checklist unit's file drove this update (ADR-060):
   * the parent checklist basename the unit hangs off, which the acceptance rule
   * compares against the run's active checklist.
   */
  parentChecklist?: string,
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
  agentRequestIds?: WatchedRemoteFile[]; // fs.watch request IDs for remote task, signal, and child-unit watches
  lastCheckboxHash?: string; // debounce: only emit when checkboxes actually change
  /** `subtasks/index.json` beside this context's checklist — the child registry. */
  subtaskIndexFilePath: string;
  /**
   * Local only: ONE non-recursive chokidar watch on the `subtasks/` DIRECTORY,
   * dispatched by basename. A watch registered on a not-yet-existing FILE is
   * platform-dependent — fsevents surfaces the later creation, inotify does not —
   * so the directory is the portable subject. It also covers every child file, so
   * local needs no per-unit watchers.
   */
  subtasksDirWatcher?: FSWatcher;
  /** Per-key serialization of index-driven child-watch rebinds. */
  subtaskRebind?: Promise<boolean>;
}

/** A remote file this watch asked the node to watch, by request id. */
interface WatchedRemoteFile {
  requestId: string;
  kind: WatchedFileKind;
  path: string;
}

type WatchedFileKind = 'task' | 'signal' | 'subtask-index' | 'subtask-checklist' | 'subtask-signal';

interface WatchSlotOptions {
  runId?: string;
  contexts?: AgentContext[];
  /** Recheck asynchronous setup before it can replace another owner's watch. */
  assertCurrent?: () => Promise<void>;
}

const activeWatches = new Map<string, SlotWatch>();
const pendingWatchKeys = new Map<string, Promise<void>>();
const handlers: TaskProgressHandler[] = [];
const signalHandlers: WorkerSignalHandler[] = [];

// Debounce interval — don't re-parse on every keystroke
const DEBOUNCE_MS = 1000;
/** Bound on waiting for a chokidar watcher's initial scan (see watcherReady). */
const WATCHER_READY_TIMEOUT_MS = 5000;
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
  parentChecklist?: string,
): void {
  for (const h of handlers) h(slotId, progress, role, contextId, runId, parentChecklist);
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

/**
 * Resolve once a chokidar watcher has finished its initial scan and its OS watch
 * is armed. Bounded: a pathological filesystem must not hold up a dispatch, and a
 * watcher that never signals still observes later changes — it just cannot
 * promise it caught one racing the setup.
 */
async function watcherReady(watcher: FSWatcher, subject: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[task-watcher] watch on ${subject} did not report ready within 5s`);
      resolve();
    }, WATCHER_READY_TIMEOUT_MS);
    watcher.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
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
  if (options.assertCurrent) await options.assertCurrent();
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
    // Watch and hash the file whose checkboxes are the steps: CHECKLIST.md when
    // the task dir has one, otherwise the context's task file. Hashing TASK.md
    // would freeze progress after the first update because `mark N` edits
    // CHECKLIST.md. The slot probe that decides between the two runs inside the
    // pending setup below, so unwatchSlot can drain it; a probe before
    // registration let a release return while this setup was still in flight.
    const candidateTaskPath = resolveContextFilePath(
      vars.remoteRepo,
      context?.taskFile,
      taskMdPath,
    );
    const checklistCandidatePath = resolveTaskProgressMarkdownPath(candidateTaskPath);
    const contextSignalPath = resolveContextFilePath(
      vars.remoteRepo,
      context?.signalFile,
      signalPath,
      candidateTaskPath,
    );
    const runId = options.runId ?? context?.runId ?? activeRun?.id ?? null;
    const existingWatch = activeWatches.get(key);
    const identityFor = (taskFilePath: string) => ({
      runId,
      taskFilePath,
      signalFilePath: contextSignalPath,
    });
    // Fast path: identical live watch (on either candidate file) with no rebind
    // in flight — nothing to do. With one in flight the live entry may be about
    // to change, so the authoritative check happens inside the chained promise.
    if (
      existingWatch &&
      !pendingWatchKeys.has(key) &&
      (!shouldRebindWatch(existingWatch, identityFor(candidateTaskPath)) ||
        !shouldRebindWatch(existingWatch, identityFor(checklistCandidatePath)))
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
      const contextTaskPath = await resolveTaskProgressMarkdownPathForSlot(vars, candidateTaskPath);
      if (options.assertCurrent) await options.assertCurrent();
      const nextWatchIdentity = identityFor(contextTaskPath);
      const staleWatch = activeWatches.get(key);
      if (staleWatch && !shouldRebindWatch(staleWatch, nextWatchIdentity)) return;
      if (staleWatch) {
        // Raw teardown: this code IS the chained operation for this key —
        // the chain-aware unwatchKey would await its own promise.
        await closeWatchEntry(key, { expected: staleWatch });
        if (options.assertCurrent) await options.assertCurrent();
      }
      const sw: SlotWatch = {
        slotId,
        taskFilePath: contextTaskPath,
        signalFilePath: contextSignalPath,
        subtaskIndexFilePath: subtaskIndexPathFor(path.dirname(contextTaskPath)),
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

        // Child units (ADR-060). `subtasks/` appears only with the first
        // `mark sub start`, and both watch primitives observe a file through its
        // parent directory, so the directory the contract defines is created
        // first. Nothing is written into it: the gateway never authors a child.
        await ensureSubtasksDir(sw, contextTaskPath);
        const subtasksDir = subtasksDirFor(path.dirname(contextTaskPath));
        // The DIRECTORY is the watch subject, not the files inside it. Watching a
        // path that does not exist yet works on macOS (fsevents replays the
        // creation) and does not on Linux (inotify has nothing to attach to), so
        // per-file watches here passed locally and timed out in CI. One
        // non-recursive directory watch reports creation AND modification of
        // every entry on both, and needs no rebinding when a unit is registered.
        const subtasksDirWatcher = watch(subtasksDir, {
          persistent: false,
          ignoreInitial: true,
          depth: 0,
        });
        const onSubtasksEntry = (entryPath: string) => {
          const name = path.basename(entryPath);
          // Orchestrator mirror output a re-dispatch may have copied in; not
          // worker progress.
          if (name.endsWith(WORKER_MIRROR_SUFFIX)) return;
          if (name === SUBTASK_INDEX_FILE) {
            void handleSubtaskIndexChange(key);
            return;
          }
          // A child checklist or child signal moved. Progress only: a child never
          // drives run lifecycle, so no WORKER_SIGNAL is emitted for it.
          debouncedSubtaskUpdate(key);
        };
        subtasksDirWatcher.on('add', onSubtasksEntry);
        subtasksDirWatcher.on('change', onSubtasksEntry);
        sw.subtasksDirWatcher = subtasksDirWatcher;

        activeWatches.set(key, sw);
        // Wait for the initial scan to finish before returning. Until chokidar is
        // ready its OS watch is not armed, and a file created in that gap produces
        // no event at all — so without this a child registered immediately after
        // dispatch could go unobserved for the rest of the run.
        await watcherReady(subtasksDirWatcher, subtasksDir);
        console.log(
          `[task-watcher] watching local ${key}: ${contextTaskPath} + ${contextSignalPath} + ${subtasksDir}/`,
        );
        // A registry that already exists when the watch arms — a gateway restart
        // mid-run, or a worker that registered before this point — produced no
        // event, so it is read once here. `ignoreInitial: true` above means this is
        // the ONLY path that reports it, and it emits nothing when there is no
        // registry to report.
        await handleSubtaskIndexChange(key);
      } else {
        // Remote slot — use node fs.watch
        const node = getNode(slot.machine);
        if (!node) {
          console.log(`[task-watcher] no node for ${slot.machine} — skipping remote watch`);
          return;
        }

        try {
          const requestIds: WatchedRemoteFile[] = [];
          (await sendNodeRequest(
            node,
            'fs.watch',
            { path: contextTaskPath },
            {
              onRequestId: (id) =>
                requestIds.push({ requestId: id, kind: 'task', path: contextTaskPath }),
            },
          )) as { watching: boolean };
          try {
            (await sendNodeRequest(
              node,
              'fs.watch',
              { path: contextSignalPath },
              {
                onRequestId: (id) =>
                  requestIds.push({ requestId: id, kind: 'signal', path: contextSignalPath }),
              },
            )) as { watching: boolean };
          } catch (err) {
            console.log(
              `[task-watcher] signal file not yet present for remote ${key}: ${(err as Error).message}`,
            );
          }
          // The node's fs.watch primitive watches the target's PARENT directory,
          // so `subtasks/` must exist before the index watch can attach — see
          // ensureSubtasksDir.
          await ensureSubtasksDir(sw, contextTaskPath);
          try {
            (await sendNodeRequest(
              node,
              'fs.watch',
              { path: sw.subtaskIndexFilePath },
              {
                onRequestId: (id) =>
                  requestIds.push({
                    requestId: id,
                    kind: 'subtask-index',
                    path: sw.subtaskIndexFilePath,
                  }),
              },
            )) as { watching: boolean };
          } catch (err) {
            console.log(
              `[task-watcher] subtask index not watchable for remote ${key}: ${(err as Error).message}`,
            );
          }
          sw.agentRequestIds = requestIds;
          activeWatches.set(key, sw);
          console.log(
            `[task-watcher] watching remote ${key} via node ${slot.machine}: ${contextTaskPath} + ${contextSignalPath} + ${sw.subtaskIndexFilePath}`,
          );
          // The node's watch reports changes only, so an index that already exists
          // (gateway restart, re-watch mid-run) needs one read to wire its child
          // watches. The local path does the same thing for the same reason: its
          // directory watch is `ignoreInitial: true`, so the setup read below is
          // the only thing that reports a pre-existing registry.
          await handleSubtaskIndexChange(key);
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
      if (options.assertCurrent) throw err;
      console.warn(
        `[task-watcher] invalid context watch path for ${key}: ${(err as Error).message}`,
      );
    } finally {
      if (pendingWatchKeys.get(key) === startWatch) pendingWatchKeys.delete(key);
    }
  }
}

export async function watchContext(
  slotId: string,
  context: AgentContext,
  options: Pick<WatchSlotOptions, 'assertCurrent'> = {},
): Promise<void> {
  await watchSlot(slotId, { ...options, runId: context.runId, contexts: [context] });
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
  // wiring must never strip watches a foreign run registered since. The owner
  // scope is re-checked inside the chained teardown against the live entry —
  // a SAME-run replacement landing mid-close is still torn down (all of that
  // run's wiring goes); only a foreign run's replacement survives.
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
    // Context IDs are role-based and reused across runs: a foreign successor
    // may have re-registered this key already, and removing its watch would
    // strip the new owner's observability. The owner scope is authoritative
    // and re-checked inside the chained teardown: a SAME-run replacement
    // landing after this check is still torn down; a foreign run's survives.
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
  if (sw.subtasksDirWatcher) {
    await sw.subtasksDirWatcher.close();
  }
  await closeSubtaskUnitWatchers(sw);

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
    for (const timerKey of [key, subtaskDebounceKey(key)]) {
      const timer = debounceTimers.get(timerKey);
      if (timer) clearTimeout(timer);
      debounceTimers.delete(timerKey);
    }
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
    // Every registered request records the path it was opened for, so a node
    // replaying an event for a different file is rejected rather than routed.
    if (payload.path !== request.path) {
      console.warn(
        `[task-watcher] ignoring ${request.kind} watch path mismatch for ${key}: request=${payload.requestId} path=${payload.path}`,
      );
      return;
    }
    if (request.kind === 'task') {
      debouncedUpdate(key, payload.content);
      return;
    }
    if (request.kind === 'signal') {
      void handleSignalChange(key, payload.content);
      return;
    }
    if (request.kind === 'subtask-index') {
      void handleSubtaskIndexChange(key, payload.content);
      return;
    }
    // A child checklist or child signal changed. Both are progress-only: a child
    // never drives run lifecycle, so no WORKER_SIGNAL is emitted for it.
    debouncedSubtaskUpdate(key);
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

/**
 * Debounce key for child-unit-driven updates. A child mark and a parent mark can
 * land together (`sub complete` writes both files), and they need different
 * handling — the child update skips the parent checkbox-hash guard — so they get
 * their own timer instead of overwriting each other's.
 */
function subtaskDebounceKey(key: string): string {
  return `${key}#subtask`;
}

/**
 * A child unit's checklist or signal changed. Same debounce as a parent change,
 * but it bypasses the parent checkbox hash (a child mark never changes a parent
 * box, so the guard would swallow every child update) and tags the broadcast
 * with the parent checklist so the acceptance rule can place it.
 */
function debouncedSubtaskUpdate(key: string): void {
  const timerKey = subtaskDebounceKey(key);
  const existing = debounceTimers.get(timerKey);
  if (existing) clearTimeout(existing);

  debounceTimers.set(
    timerKey,
    setTimeout(async () => {
      debounceTimers.delete(timerKey);
      await computeAndEmit(key, undefined, { fromSubtask: true });
    }, DEBOUNCE_MS),
  );
}

interface ComputeAndEmitOptions {
  /**
   * The update originates from a child unit's file: skip the parent
   * checkbox-hash short-circuit and carry `parentChecklist` on the broadcast.
   */
  fromSubtask?: boolean;
}

async function computeAndEmit(
  key: string,
  content?: string,
  options: ComputeAndEmitOptions = {},
): Promise<void> {
  const sw = activeWatches.get(key);
  if (!sw) return;

  try {
    if (!options.fromSubtask) {
      // Read fresh content if not provided
      let markdown = content;
      if (!markdown) {
        markdown = await slotReadFile(sw, sw.taskFilePath);
      }

      // Quick hash of checkbox states to avoid redundant broadcasts
      const checkboxHash = hashCheckboxes(markdown);
      if (checkboxHash === sw.lastCheckboxHash) return;
      sw.lastCheckboxHash = checkboxHash;
    }

    // Use the existing taskProgress method to get structured progress
    const result = await taskProgress({
      slotId: sw.slotId,
      runId: sw.runId ?? undefined,
      role: sw.role,
      contextId: sw.contextId,
    });
    emit(
      sw.slotId,
      result,
      sw.role,
      sw.contextId,
      sw.runId,
      options.fromSubtask ? path.basename(sw.taskFilePath) : undefined,
    );
  } catch (err) {
    // The watch survives a failed read: the file may have been deleted (slot
    // released mid-update), and the next event re-reads it. Reported at error
    // level with the key and the reason because the alternative reading — a
    // corrupt child registry or signal — means clients are now showing progress
    // that has stopped advancing, and nothing else in the log would say so.
    console.error(
      `[task-watcher] progress read failed for ${key} (${sw.taskFilePath}): ${(err as Error).message}`,
    );
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

// ─── Child checklist units (ADR-060) ───

/**
 * Make sure `subtasks/` exists beside a context's checklist before a watch
 * attaches to the registry inside it.
 *
 * Both watch primitives observe a file through its PARENT directory — chokidar
 * because that is how it survives atomic replacement, the node's `watchFile`
 * explicitly (it skips the watch and logs when the parent is missing). `mark sub
 * start` creates `subtasks/` only on the first registration, so without this the
 * registry of a child registered mid-run would never be seen. The gateway
 * creates the directory the task-directory contract defines and nothing else: it
 * never writes an index, a child checklist, or a child signal.
 */
async function ensureSubtasksDir(sw: SlotWatch, contextTaskPath: string): Promise<void> {
  const taskDir = path.dirname(contextTaskPath);
  // Only when the checklist itself is there: a released slot must not have its
  // task tree recreated by the observer.
  if (!(await slotFileExists(sw, contextTaskPath))) return;
  await slotMkdir(sw, subtasksDirFor(taskDir));
}

/**
 * Stop the remote per-unit file watches. Local slots have none: their single
 * `subtasks/` directory watch already covers every child file.
 */
async function closeSubtaskUnitWatchers(sw: SlotWatch): Promise<void> {
  const unitRequests = (sw.agentRequestIds ?? []).filter(
    (entry) => entry.kind === 'subtask-checklist' || entry.kind === 'subtask-signal',
  );
  if (unitRequests.length === 0) return;
  sw.agentRequestIds = (sw.agentRequestIds ?? []).filter(
    (entry) => entry.kind !== 'subtask-checklist' && entry.kind !== 'subtask-signal',
  );
  const fleet = await loadFleetStatus();
  const slot = fleet.slots.find((candidate) => candidate.slot === sw.slotId);
  const node = slot ? getNode(slot.machine) : null;
  if (!node) return;
  await Promise.all(
    unitRequests.map(async ({ requestId }) => {
      try {
        await sendNodeRequest(node, 'fs.watch.stop', { requestId });
      } catch (err) {
        console.warn(
          `[task-watcher] failed to stop remote subtask watch ${requestId}: ${(err as Error).message}`,
        );
      }
    }),
  );
}

/**
 * The registry changed (or was read for the first time): rewire the child file
 * watches, then emit one progress update so clients see the new unit without
 * waiting for its first mark.
 *
 * Serialized per watch: `mark sub start` writes the index and the child pair in
 * quick succession, so a second index event can arrive while the first rebind is
 * still opening watchers. Without the chain both rebinds would register watchers
 * and only one set would be tracked for teardown.
 */
async function handleSubtaskIndexChange(key: string, content?: string): Promise<void> {
  const sw = activeWatches.get(key);
  if (!sw) return;
  const prior = sw.subtaskRebind;
  const rebind: Promise<boolean> = (async () => {
    if (prior) {
      try {
        await prior;
      } catch {
        // The prior rebind reports its own failure at its own await site; this
        // one only needs it settled before it touches the watcher list.
      }
    }
    return rebindSubtaskUnitWatches(key, content);
  })();
  sw.subtaskRebind = rebind;
  let sawRegistry = false;
  try {
    sawRegistry = await rebind;
  } finally {
    if (sw.subtaskRebind === rebind) sw.subtaskRebind = undefined;
  }
  // Nothing to report when the task directory has no registry: this function also
  // runs once at watch setup, where an empty `subtasks/` is the normal case and an
  // update would be noise on every dispatch.
  if (sawRegistry) debouncedSubtaskUpdate(key);
}

/** Returns true when a registry was read (whatever it listed for this checklist). */
async function rebindSubtaskUnitWatches(key: string, content?: string): Promise<boolean> {
  const sw = activeWatches.get(key);
  if (!sw) return false;
  const taskDir = path.dirname(sw.taskFilePath);
  const parentChecklist = path.basename(sw.taskFilePath);

  let index: SubtaskIndex | null;
  try {
    index = content
      ? parseSubtaskIndex(content, sw.subtaskIndexFilePath)
      : await readSubtaskIndex(sw, taskDir);
  } catch (err) {
    // `mark` is the registry's only writer, so a file that does not parse is a
    // real fault, not a shape to tolerate. It is reported at error level and the
    // child watches are left as they were — a torn-down watch would also hide
    // the children that were already registered correctly. The projection read
    // in taskProgress raises the same failure to its RPC caller.
    console.error(
      `[task-watcher] cannot read subtask registry for ${key}: ${(err as Error).message}`,
    );
    // A registry that exists but cannot be parsed is still a registry: the
    // progress read must run so the failure reaches clients as a read error
    // rather than as silence.
    return true;
  }
  if (!index) return false;

  await closeSubtaskUnitWatchers(sw);
  // Each context watches only the children of ITS OWN checklist: a unit parented
  // on SELF-REVIEW.md belongs to the self-review context's watch, and a unit
  // whose parent checklist is not this one is not live here.
  const units = subtaskUnitsForParentChecklist(index, parentChecklist);
  // A registry with no unit for THIS checklist is still a registry the caller
  // should report: a sibling context's child may have just been registered.
  if (units.length === 0) return true;

  if (sw.isLocal) {
    // Nothing to wire: the `subtasks/` directory watch installed at setup already
    // reports every child checklist and signal, including files created later.
    console.log(
      `[task-watcher] ${units.length} subtask unit(s) registered for local ${key}: ${units.map((unit) => unit.id).join(', ')}`,
    );
    return true;
  }

  const fleet = await loadFleetStatus();
  const slot = fleet.slots.find((candidate) => candidate.slot === sw.slotId);
  const node = slot ? getNode(slot.machine) : null;
  if (!node) {
    console.log(`[task-watcher] no node for ${sw.machine} — skipping remote subtask watches`);
    return true;
  }
  for (const unit of units) {
    for (const [kind, filePath] of [
      ['subtask-checklist', path.join(taskDir, unit.checklist)],
      ['subtask-signal', path.join(taskDir, unit.signal)],
    ] as const) {
      try {
        (await sendNodeRequest(
          node,
          'fs.watch',
          { path: filePath },
          {
            onRequestId: (id) => {
              // Re-read the live entry: a rebind that lost the chain must not
              // resurrect a torn-down watch's bookkeeping.
              const live = activeWatches.get(key);
              if (live !== sw) return;
              sw.agentRequestIds = [
                ...(sw.agentRequestIds ?? []),
                { requestId: id, kind, path: filePath },
              ];
            },
          },
        )) as { watching: boolean };
      } catch (err) {
        console.log(
          `[task-watcher] subtask file not yet watchable for remote ${key} (${unit.id}): ${(err as Error).message}`,
        );
      }
    }
  }
  console.log(
    `[task-watcher] watching ${units.length} subtask unit(s) for remote ${key}: ${units.map((unit) => unit.id).join(', ')}`,
  );
  return true;
}

/** Absolute child checklist + signal paths for the units of one parent checklist. */
export function subtaskUnitFilePaths(
  taskDir: string,
  units: readonly SubtaskIndexUnit[],
): string[] {
  return units.flatMap((unit) => [
    path.join(taskDir, unit.checklist),
    path.join(taskDir, unit.signal),
  ]);
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
