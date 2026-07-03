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
import { isRunListActiveRun } from '../runs/run-list-model.js';

/** Stable pane ordering when multiple active runs share a slot. */
const ACTIVE_RUN_TERMINAL_PRIORITY: Partial<Record<RunStatus, number>> = {
  blocked: 7,
  'human-gating': 7,
  monitoring: 6,
  'self-reviewing': 5,
  completing: 5,
  'ci-watching': 4,
  paused: 4,
  preparing: 3,
  dispatching: 3,
  'slot-finding': 2,
  'writing-task': 2,
  grading: 2,
  created: 1,
  failed: 1,
};

const ACTIVE_RUN_SLOT_LIMIT = 8;

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
  return parsed.filter(isTmuxWorkerRef);
}

export function isTmuxWorkerRef(value: unknown): value is TmuxWorkerRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TmuxWorkerRef).nodeId === 'string' &&
    typeof (value as TmuxWorkerRef).session === 'string' &&
    typeof (value as TmuxWorkerRef).target === 'string'
  );
}

export function encodeWorkerRouteParam(ref: TmuxWorkerRef): string {
  return JSON.stringify(ref);
}

export function parseWorkerRouteParam(raw: string | null): TmuxWorkerRef | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isTmuxWorkerRef(parsed) ? parsed : null;
  } catch {
    // Route state is optional and user-editable; malformed worker params are ignored.
    return null;
  }
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

function activeRunTerminalPriority(status: RunStatus): number {
  return ACTIVE_RUN_TERMINAL_PRIORITY[status] ?? 0;
}

function compareTerminalRuns(a: Run, b: Run): number {
  const priorityDiff = activeRunTerminalPriority(b.status) - activeRunTerminalPriority(a.status);
  if (priorityDiff !== 0) return priorityDiff;
  return Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt);
}

function activeRunForSlot(
  slot: SlotStatus,
  runs: readonly Run[],
  runsById: Map<string, Run>,
): Run | null {
  let best: Run | null = null;
  for (const run of runs) {
    if (run.slotId !== slot.slot || !isRunListActiveRun(run)) continue;
    if (!best || compareTerminalRuns(run, best) > 0) best = run;
  }
  if (best) return best;

  if (slot.currentRunId) {
    const linked = runsById.get(slot.currentRunId);
    if (linked && isRunListActiveRun(linked)) return linked;
  }

  for (const context of slot.agentContexts ?? []) {
    if (!context.runId) continue;
    const contextRun = runsById.get(context.runId);
    if (!contextRun || !isRunListActiveRun(contextRun)) continue;
    if (!best || compareTerminalRuns(contextRun, best) > 0) best = contextRun;
  }
  return best;
}

export function slotHasActiveRunTerminal(slot: SlotStatus, runsById: Map<string, Run>): boolean {
  if (slot.currentRunId) {
    const run = runsById.get(slot.currentRunId);
    if (run) return isRunListActiveRun(run);
  }
  for (const context of slot.agentContexts ?? []) {
    if (!context.runId) continue;
    const run = runsById.get(context.runId);
    if (run && isRunListActiveRun(run)) return true;
  }
  return slot.lifecycle === 'busy' && slot.phase === 'working';
}

export function isActiveRunTerminalSlot(
  slot: SlotStatus,
  runs: readonly Run[],
  runsById: Map<string, Run> = runById(runs),
): boolean {
  if (slot.lifecycle === 'manual') {
    return Boolean(slot.taskFile && slot.agent === 'working');
  }
  if (slot.lifecycle === 'disabled') return false;

  if (activeRunForSlot(slot, runs, runsById)) return true;
  return slotHasActiveRunTerminal(slot, runsById);
}

function activeRunSlotSortKey(
  slot: SlotStatus,
  runs: readonly Run[],
  runsById: Map<string, Run>,
): [priority: number, updatedAt: number] {
  if (slot.lifecycle === 'manual') return [0, 0];

  const run = activeRunForSlot(slot, runs, runsById);
  if (run) {
    return [activeRunTerminalPriority(run.status), Date.parse(run.updatedAt || run.createdAt)];
  }
  if (slotHasActiveRunTerminal(slot, runsById)) {
    // Fleet snapshot shows an in-flight worker before run.list catches up.
    return [4, 0];
  }
  return [0, 0];
}

function compareActiveRunSlots(
  a: SlotStatus,
  b: SlotStatus,
  runs: readonly Run[],
  runsById: Map<string, Run>,
): number {
  const [priorityA, updatedA] = activeRunSlotSortKey(a, runs, runsById);
  const [priorityB, updatedB] = activeRunSlotSortKey(b, runs, runsById);
  if (priorityA !== priorityB) return priorityB - priorityA;
  if (updatedA !== updatedB) return updatedB - updatedA;
  return a.slot.localeCompare(b.slot);
}

export function selectActiveRunSlotIds(
  slots: readonly SlotStatus[],
  runs: readonly Run[],
  filters: GlobalFilters,
  limit = ACTIVE_RUN_SLOT_LIMIT,
): string[] {
  const runsById = runById(runs);
  return filterSlotsByGlobalFilters(slots, filters)
    .filter((slot) => isActiveRunTerminalSlot(slot, runs, runsById))
    .sort((a, b) => compareActiveRunSlots(a, b, runs, runsById))
    .slice(0, limit)
    .map((slot) => slot.slot);
}

export function selectPinnedSlotIds(
  slots: readonly SlotStatus[],
  pinnedSlotIds: readonly string[],
  filters: GlobalFilters,
  limit = ACTIVE_RUN_SLOT_LIMIT,
): string[] {
  const visible = new Set(filterSlotsByGlobalFilters(slots, filters).map((slot) => slot.slot));
  return pinnedSlotIds.filter((slotId) => visible.has(slotId)).slice(0, limit);
}
