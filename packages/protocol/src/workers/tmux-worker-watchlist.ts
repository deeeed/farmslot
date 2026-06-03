import type { TmuxWorkerRef, TmuxWorkerSummary } from '../rpc/tmux.js';

export interface TmuxWorkerWatchItem {
  id: string;
  ref: TmuxWorkerRef;
  nodeId: string;
  target: string;
  title?: string;
  cwd?: string;
  command?: string;
  branch?: string;
  linkedSlotId?: string;
  linkedRunId?: string;
  linkedFamilyId?: string;
  statusLabel?: string;
  pinnedAt: number;
  lastSeenAt?: number;
}

export interface TmuxWorkerWatchEntry {
  id: string;
  ref: TmuxWorkerRef;
  item: TmuxWorkerWatchItem;
  worker?: TmuxWorkerSummary;
  live: boolean;
}

export function tmuxWorkerWatchId(ref: Pick<TmuxWorkerRef, 'nodeId' | 'target'>): string {
  return `${ref.nodeId}:${ref.target}`;
}

export function tmuxWorkerRefsMatch(
  a: Pick<TmuxWorkerRef, 'nodeId' | 'target'> | undefined,
  b: Pick<TmuxWorkerRef, 'nodeId' | 'target'> | undefined,
): boolean {
  return Boolean(a && b && a.nodeId === b.nodeId && a.target === b.target);
}

export function createTmuxWorkerWatchItem(
  worker: TmuxWorkerSummary,
  now = Date.now(),
): TmuxWorkerWatchItem {
  const id = tmuxWorkerWatchId(worker.ref);
  return {
    id,
    ref: worker.ref,
    nodeId: worker.ref.nodeId,
    target: worker.ref.target,
    ...(worker.title ? { title: worker.title } : {}),
    ...(worker.cwd ? { cwd: worker.cwd } : {}),
    ...(worker.command ? { command: worker.command } : {}),
    ...(worker.branch ? { branch: worker.branch } : {}),
    ...(worker.linkedSlotId ? { linkedSlotId: worker.linkedSlotId } : {}),
    ...(worker.linkedRunId ? { linkedRunId: worker.linkedRunId } : {}),
    ...(worker.linkedFamilyId ? { linkedFamilyId: worker.linkedFamilyId } : {}),
    ...(worker.status.label ? { statusLabel: worker.status.label } : {}),
    pinnedAt: now,
    lastSeenAt: now,
  };
}

export function refreshTmuxWorkerWatchItem(
  item: TmuxWorkerWatchItem,
  worker: TmuxWorkerSummary,
  now = Date.now(),
): TmuxWorkerWatchItem {
  return {
    id: item.id,
    ref: worker.ref,
    nodeId: worker.ref.nodeId,
    target: worker.ref.target,
    ...(worker.title ? { title: worker.title } : {}),
    ...(worker.cwd ? { cwd: worker.cwd } : {}),
    ...(worker.command ? { command: worker.command } : {}),
    ...(worker.branch ? { branch: worker.branch } : {}),
    ...(worker.linkedSlotId ? { linkedSlotId: worker.linkedSlotId } : {}),
    ...(worker.linkedRunId ? { linkedRunId: worker.linkedRunId } : {}),
    ...(worker.linkedFamilyId ? { linkedFamilyId: worker.linkedFamilyId } : {}),
    ...(worker.status.label ? { statusLabel: worker.status.label } : {}),
    pinnedAt: item.pinnedAt,
    lastSeenAt: now,
  };
}

export function upsertTmuxWorkerWatchItem(
  items: readonly TmuxWorkerWatchItem[],
  worker: TmuxWorkerSummary,
  now = Date.now(),
): TmuxWorkerWatchItem[] {
  const id = tmuxWorkerWatchId(worker.ref);
  let found = false;
  const updated = items.map((item) => {
    if (item.id !== id) return item;
    found = true;
    return refreshTmuxWorkerWatchItem(item, worker, now);
  });
  if (found) return updated;
  return [createTmuxWorkerWatchItem(worker, now), ...updated];
}

export function removeTmuxWorkerWatchItem(
  items: readonly TmuxWorkerWatchItem[],
  ref: Pick<TmuxWorkerRef, 'nodeId' | 'target'>,
): TmuxWorkerWatchItem[] {
  const id = tmuxWorkerWatchId(ref);
  return items.filter((item) => item.id !== id);
}

export function isTmuxWorkerWatched(
  items: readonly TmuxWorkerWatchItem[],
  ref: Pick<TmuxWorkerRef, 'nodeId' | 'target'>,
): boolean {
  const id = tmuxWorkerWatchId(ref);
  return items.some((item) => item.id === id);
}

export function reconcileTmuxWorkerWatchlist(
  items: readonly TmuxWorkerWatchItem[],
  workers: readonly TmuxWorkerSummary[],
  now = Date.now(),
): TmuxWorkerWatchEntry[] {
  const liveById = new Map(workers.map((worker) => [tmuxWorkerWatchId(worker.ref), worker]));
  return items.map((item) => {
    const worker = liveById.get(item.id);
    const refreshed = worker ? refreshTmuxWorkerWatchItem(item, worker, now) : item;
    return {
      id: item.id,
      ref: refreshed.ref,
      item: refreshed,
      ...(worker ? { worker } : {}),
      live: Boolean(worker),
    };
  });
}

export function flattenTmuxWorkers(nodes: readonly { workers: readonly TmuxWorkerSummary[] }[]) {
  return nodes.flatMap((node) => node.workers);
}
