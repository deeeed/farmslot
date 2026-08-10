// Shared transfer progress store for Command Center surfaces (banner, run detail,
// pipeline package-refresh / finalize). One gateway subscription, many listeners.

import { Events, type FileTransferProgress } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

import {
  type FileTransferUiEntry,
  pruneFileTransfers,
  upsertFileTransfer,
} from './file-transfer-progress-model.js';

type Listener = () => void;

let entries: FileTransferUiEntry[] = [];
const listeners = new Set<Listener>();
let unsubGateway: (() => void) | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
let refCount = 0;

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* listener errors must not break other surfaces */
    }
  }
}

function onProgress(progress: FileTransferProgress): void {
  entries = pruneFileTransfers(upsertFileTransfer(entries, progress));
  notify();
}

function ensureSubscribed(): void {
  if (unsubGateway) return;
  unsubGateway = gateway.subscribe<FileTransferProgress>(Events.FILE_TRANSFER_PROGRESS, onProgress);
  pruneTimer = setInterval(() => {
    const next = pruneFileTransfers(entries);
    if (next.length !== entries.length || next.some((e, i) => e !== entries[i])) {
      entries = next;
      notify();
    }
  }, 1000);
}

function maybeUnsubscribe(): void {
  if (refCount > 0 || listeners.size > 0) return;
  unsubGateway?.();
  unsubGateway = null;
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

/** Retain the gateway subscription for the lifetime of a UI surface. */
export function retainFileTransferStore(): () => void {
  refCount += 1;
  ensureSubscribed();
  return () => {
    refCount = Math.max(0, refCount - 1);
    maybeUnsubscribe();
  };
}

export function subscribeFileTransferStore(listener: Listener): () => void {
  listeners.add(listener);
  ensureSubscribed();
  return () => {
    listeners.delete(listener);
    maybeUnsubscribe();
  };
}

export function getFileTransferEntries(): readonly FileTransferUiEntry[] {
  return entries;
}

export function getFileTransfersForRun(runId: string | undefined | null): FileTransferUiEntry[] {
  if (!runId) return [...entries];
  return entries.filter((e) => !e.runId || e.runId === runId);
}

/** Best summary for pipeline nodes: prefer running, else latest terminal. */
export function primaryTransferForRun(runId: string | undefined | null): FileTransferUiEntry | null {
  const list = getFileTransfersForRun(runId);
  if (list.length === 0) return null;
  const running = list.filter((e) => e.state === 'running');
  if (running.length > 0) {
    // Prefer mirror/upload aggregates (dir sessions have filesTotal).
    const aggregate = running.find((e) => (e.filesTotal ?? 0) > 0);
    return aggregate ?? running[running.length - 1]!;
  }
  return list[list.length - 1] ?? null;
}

export function formatPipelineTransferMeta(entry: FileTransferUiEntry): string {
  const pct =
    entry.totalBytes > 0
      ? Math.min(100, Math.round((entry.bytesTransferred / entry.totalBytes) * 100))
      : 0;
  const files =
    entry.filesTotal != null && entry.filesTotal > 0
      ? ` ${entry.filesCompleted ?? 0}/${entry.filesTotal}f`
      : '';
  if (entry.state === 'running') {
    const label = entry.label ? entry.label.slice(0, 14) : entry.phase;
    return `${label} ${pct}%${files}`;
  }
  if (entry.state === 'failed' || entry.state === 'cancelled') {
    return entry.state;
  }
  return entry.state === 'done' ? `done ${pct}%` : entry.state;
}

/** Test helper — reset store between tests. */
export function _resetFileTransferStoreForTests(): void {
  entries = [];
  listeners.clear();
  unsubGateway?.();
  unsubGateway = null;
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = null;
  refCount = 0;
}
