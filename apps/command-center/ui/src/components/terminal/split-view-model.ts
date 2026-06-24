import type {
  Run,
  RunStatus,
  SlotStatus,
  TmuxWorkerRef,
  TmuxWorkerSummary,
  TmuxWorkerWatchEntry,
  TmuxWorkerWatchItem,
} from '@farmslot/protocol';

import type { GlobalFilters } from '../../state.js';
import { isSidebarActiveRun } from '../app-shell-nav-model.js';

/** Run phases where the slot worker pane should be open in a terminal grid. */
const ACTIVE_RUN_TERMINAL_STATUSES = new Set<RunStatus>([
  'monitoring',
  'self-reviewing',
  'completing',
]);

export type LayoutMode = 'auto' | '1x1' | '2x1' | '2x2' | '3x2' | '4x2';

export const STORAGE_KEY = 'farmslot:split-view:slots';
export const LAYOUT_KEY = 'farmslot:split-view:layout';
export const WORKER_WATCHLIST_KEY = 'farmslot:terminal-watchlist:v1';
export const WORKER_PANES_KEY = 'farmslot:split-view:worker-panes';
export const WORKER_FILTER_KEY = 'farmslot:terminal-worker-filter';

export type TerminalPane =
  | { type: 'worker'; ref: TmuxWorkerRef }
  | { type: 'slot'; slotId: string; index: number };
export type WorkerPaneFilter = 'adhoc' | 'all' | 'farmslot';

export function parseWorkerRefs(raw: string | null): TmuxWorkerRef[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is TmuxWorkerRef =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as TmuxWorkerRef).nodeId === 'string' &&
      typeof (item as TmuxWorkerRef).session === 'string' &&
      typeof (item as TmuxWorkerRef).target === 'string',
  );
}

export function parseWatchItems(raw: string | null): TmuxWorkerWatchItem[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is TmuxWorkerWatchItem =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as TmuxWorkerWatchItem).id === 'string' &&
      typeof (item as TmuxWorkerWatchItem).nodeId === 'string' &&
      typeof (item as TmuxWorkerWatchItem).target === 'string' &&
      typeof (item as TmuxWorkerWatchItem).ref?.nodeId === 'string' &&
      typeof (item as TmuxWorkerWatchItem).ref?.target === 'string',
  );
}

export function tmuxRefTitle(ref: TmuxWorkerRef): string {
  const window = ref.window ?? '0';
  const pane = ref.pane ?? ref.paneId ?? ref.target;
  const paneLabel = pane.startsWith('%') ? pane : `${window}:${pane}`;
  return `${ref.session} · ${paneLabel}`;
}

export function workerTitle(worker: TmuxWorkerSummary): string {
  return tmuxRefTitle(worker.ref);
}

export function watchEntryTitle(entry: TmuxWorkerWatchEntry): string {
  return tmuxRefTitle(entry.worker?.ref ?? entry.ref);
}

export function meaningfulPaneTitle(
  title: string | undefined,
  context: { cwd?: string; nodeId: string; session: string },
): string | null {
  const trimmed = title?.trim();
  if (!trimmed) return null;
  const cwdParts = context.cwd?.split('/').filter(Boolean) ?? [];
  const cwdBase = cwdParts[cwdParts.length - 1];
  const lowSignal = new Set([
    context.nodeId,
    context.session,
    cwdBase,
    'ad-hoc',
    'ad hoc',
    'ad-hoc codex',
    'ad hoc codex',
    'bash',
    'zsh',
    'sh',
    'fish',
    'tmux',
  ]);
  return lowSignal.has(trimmed.toLowerCase()) || lowSignal.has(trimmed) ? null : trimmed;
}

export function workerDescription(worker: TmuxWorkerSummary): string {
  const title = meaningfulPaneTitle(worker.title, {
    cwd: worker.cwd,
    nodeId: worker.ref.nodeId,
    session: worker.ref.session,
  });
  return [
    title,
    worker.status.requiresAttention ? 'needs attention' : null,
    worker.status.label,
    worker.branch,
    worker.cwd,
    worker.command ? `cmd:${worker.command}` : null,
    `${worker.ref.nodeId} ${worker.ref.target}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

export function watchEntryDescription(entry: TmuxWorkerWatchEntry): string {
  if (entry.worker) return workerDescription(entry.worker);
  const title = meaningfulPaneTitle(entry.item.title, {
    cwd: entry.item.cwd,
    nodeId: entry.ref.nodeId,
    session: entry.ref.session,
  });
  return [
    entry.live ? 'live' : 'stale',
    title,
    entry.item.statusLabel,
    entry.item.branch,
    entry.item.cwd,
    entry.item.command ? `cmd:${entry.item.command}` : null,
    `${entry.ref.nodeId} ${entry.ref.target}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

export function isWorkerPaneFilter(value: string | null): value is WorkerPaneFilter {
  return value === 'adhoc' || value === 'all' || value === 'farmslot';
}

export function isFarmslotWorker(worker: TmuxWorkerSummary): boolean {
  return Boolean(worker.linkedSlotId || worker.linkedRunId || worker.linkedFamilyId);
}

export function isFarmslotWatchEntry(entry: TmuxWorkerWatchEntry): boolean {
  return entry.worker
    ? isFarmslotWorker(entry.worker)
    : Boolean(entry.item.linkedSlotId || entry.item.linkedRunId || entry.item.linkedFamilyId);
}

export function filterSlotsByGlobalFilters(
  slots: readonly SlotStatus[],
  filters: GlobalFilters,
): SlotStatus[] {
  const { projects, machines } = filters;
  return slots.filter((slot) => {
    if (projects.length > 0 && !projects.includes(slot.project)) return false;
    if (machines.length > 0 && !machines.includes(slot.machine)) return false;
    return true;
  });
}

function runById(runs: readonly Run[]): Map<string, Run> {
  return new Map(runs.map((run) => [run.id, run]));
}

function slotHasActiveRunTerminal(slot: SlotStatus, runsById: Map<string, Run>): boolean {
  if (!slot.currentRunId) return false;
  const run = runsById.get(slot.currentRunId);
  if (run) return ACTIVE_RUN_TERMINAL_STATUSES.has(run.status);
  return slot.lifecycle === 'busy' && slot.phase === 'working';
}

export function isActiveRunTerminalSlot(slot: SlotStatus, runs: readonly Run[]): boolean {
  const runsById = runById(runs);
  if (slot.lifecycle === 'manual') {
    return Boolean(slot.taskFile && slot.agent === 'working');
  }
  if (slot.lifecycle === 'disabled' || slot.lifecycle === 'held') return false;

  for (const run of runs) {
    if (run.slotId !== slot.slot || !isSidebarActiveRun(run)) continue;
    if (ACTIVE_RUN_TERMINAL_STATUSES.has(run.status)) return true;
  }

  return slotHasActiveRunTerminal(slot, runsById);
}

export function selectActiveRunSlotIds(
  slots: readonly SlotStatus[],
  runs: readonly Run[],
  filters: GlobalFilters,
): string[] {
  return filterSlotsByGlobalFilters(slots, filters)
    .filter((slot) => isActiveRunTerminalSlot(slot, runs))
    .map((slot) => slot.slot);
}
