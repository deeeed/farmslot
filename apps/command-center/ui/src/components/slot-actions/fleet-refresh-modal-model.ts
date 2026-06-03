import type { FleetPrSummaryEntry, FleetRefreshSlotStatus, SlotStatus } from '@farmslot/protocol';

export type FleetRefreshPhase = 'loading' | 'review' | 'running' | 'done' | 'error';

export interface FleetRefreshFilterSnapshot {
  projects: string[];
  machines: string[];
}

export interface FleetRefreshRowState {
  slotId: string;
  machine: string;
  project: string;
  branch: string;
  defaultBranch: string;
  isStale: boolean;
  selected: boolean;
  prAnnotation: FleetPrSummaryEntry | null;
  status: FleetRefreshSlotStatus | 'idle';
  detail: string;
  sha: string;
  mode: 'safe' | 'force';
  /** Last log line tail (truncated for display). */
  lastLogLine: string;
  /** Full log buffer for the expanded row view. */
  log: string[];
  /** When true the row offers an inline Force Refresh button (safe-mode dirty/stale). */
  forceRecoverable: boolean;
  /** Per-slot requestId once fleet.refresh.scheduled echoes it back. */
  requestId: string;
  expanded: boolean;
}

export interface FleetRefreshReviewRows {
  rows: Map<string, FleetRefreshRowState>;
  hidden: Array<{ slotId: string; reason: string }>;
  staleSlotIds: string[];
  filteredOutCount: number;
}

export type FleetRefreshSelectionFilter = 'all' | 'safe' | 'force';

export interface FleetRefreshRowGroups {
  safe: FleetRefreshRowState[];
  forceSafe: FleetRefreshRowState[];
  forceDanger: FleetRefreshRowState[];
}

export interface FleetRefreshRunningProgress {
  total: number;
  done: number;
  failed: number;
}

export type FleetRefreshBulkSelectionTarget = 'safe' | 'force-safe';

const FLEET_REFRESH_DEFAULT_BRANCH = 'main';

export function buildFleetRefreshReviewRows(
  slots: readonly SlotStatus[],
  filterSnapshot: FleetRefreshFilterSnapshot,
): FleetRefreshReviewRows {
  const hidden: Array<{ slotId: string; reason: string }> = [];
  const rows: Map<string, FleetRefreshRowState> = new Map();
  const staleSlotIds: string[] = [];
  const projectFilter = new Set(filterSnapshot.projects);
  const machineFilter = new Set(filterSnapshot.machines);
  let filteredOutCount = 0;

  for (const slot of slots) {
    if (projectFilter.size > 0 && !projectFilter.has(slot.project)) {
      filteredOutCount += 1;
      continue;
    }
    if (machineFilter.size > 0 && !machineFilter.has(slot.machine)) {
      filteredOutCount += 1;
      continue;
    }

    const blocked = fleetRefreshBlockedReason(slot);
    if (blocked) {
      hidden.push({ slotId: slot.slot, reason: blocked });
      continue;
    }

    // Gateway truth lives in project.json default_branch but isn't surfaced via
    // fleet.status. The bulk method re-checks with full project context at execution time.
    const defaultBranch = FLEET_REFRESH_DEFAULT_BRANCH;
    const isStale = Boolean(slot.branch) && slot.branch !== defaultBranch;
    const row: FleetRefreshRowState = {
      slotId: slot.slot,
      machine: slot.machine,
      project: slot.project,
      branch: slot.branch ?? '',
      defaultBranch,
      isStale,
      selected: !isStale, // Safe rows auto-checked, Force rows opt-in
      prAnnotation: null,
      status: 'idle',
      detail: '',
      sha: '',
      mode: isStale ? 'force' : 'safe',
      lastLogLine: '',
      log: [],
      forceRecoverable: false,
      requestId: '',
      expanded: false,
    };
    rows.set(slot.slot, row);
    if (isStale) staleSlotIds.push(slot.slot);
  }

  return { rows, hidden, staleSlotIds, filteredOutCount };
}

// Pure predicate mirroring gateway's slotRefreshBlockedReason. The gateway
// re-checks at execution time so a slot that becomes busy between modal-open
// and refresh start gets skipped, not refreshed.
export function fleetRefreshBlockedReason(slot: SlotStatus): string | null {
  if (!slot.enabled) return 'disabled';
  if (slot.lifecycle === 'busy') return `busy (${slot.phase ?? 'working'})`;
  if (slot.lifecycle === 'held') return `held (${slot.phase ?? 'watch'})`;
  if (slot.lifecycle === 'disabled') return 'disabled';
  if (slot.currentRunId) return `has active run ${slot.currentRunId.slice(0, 8)}`;
  if (slot.agent === 'working') return 'agent working';
  return null;
}

/**
 * "Dangerous" force rows = stale-branch slots whose PR is OPEN or whose PR state
 * is unknown (annotation has not loaded yet, or gh is offline). Merged / closed
 * PRs and explicitly no-PR branches are safer force rows.
 */
export function isFleetRefreshDangerousRow(row: FleetRefreshRowState): boolean {
  if (!row.isStale) return false;
  const ann = row.prAnnotation;
  if (!ann) return true;
  if (ann.prNumber === null && ann.state === null) return false;
  if (ann.state === 'open') return true;
  if (ann.state === 'merged' || ann.state === 'closed') return false;
  return true;
}

export function groupFleetRefreshRows(rows: Iterable<FleetRefreshRowState>): FleetRefreshRowGroups {
  const groups: FleetRefreshRowGroups = { safe: [], forceSafe: [], forceDanger: [] };
  for (const row of rows) {
    if (!row.isStale) {
      groups.safe.push(row);
    } else if (isFleetRefreshDangerousRow(row)) {
      groups.forceDanger.push(row);
    } else {
      groups.forceSafe.push(row);
    }
  }
  return groups;
}

export function selectedFleetRefreshRowCount(
  rows: Iterable<FleetRefreshRowState>,
  filter: FleetRefreshSelectionFilter = 'all',
): number {
  let count = 0;
  for (const row of rows) {
    if (!row.selected) continue;
    if (filter === 'safe' && row.isStale) continue;
    if (filter === 'force' && !row.isStale) continue;
    count += 1;
  }
  return count;
}

export function selectedFleetRefreshDangerousRowCount(
  rows: Iterable<FleetRefreshRowState>,
): number {
  let count = 0;
  for (const row of rows) {
    if (row.selected && isFleetRefreshDangerousRow(row)) count += 1;
  }
  return count;
}

export function updateFleetRefreshRowSelection(
  rows: ReadonlyMap<string, FleetRefreshRowState>,
  slotId: string,
  selected: boolean,
  allowDangerous: boolean,
): Map<string, FleetRefreshRowState> {
  const row = rows.get(slotId);
  if (!row) return new Map(rows);
  if (selected && isFleetRefreshDangerousRow(row) && !allowDangerous) return new Map(rows);
  const next = new Map(rows);
  next.set(slotId, { ...row, selected });
  return next;
}

export function deselectFleetRefreshDangerousRows(
  rows: ReadonlyMap<string, FleetRefreshRowState>,
): Map<string, FleetRefreshRowState> {
  const next = new Map(rows);
  for (const [id, row] of next) {
    if (isFleetRefreshDangerousRow(row) && row.selected) {
      next.set(id, { ...row, selected: false });
    }
  }
  return next;
}

export function setFleetRefreshRowsSelected(
  rows: ReadonlyMap<string, FleetRefreshRowState>,
  selected: boolean,
  target: FleetRefreshBulkSelectionTarget,
): Map<string, FleetRefreshRowState> {
  const next = new Map(rows);
  for (const [id, row] of next) {
    const matchesTarget =
      target === 'safe' ? !row.isStale : row.isStale && !isFleetRefreshDangerousRow(row);
    if (matchesTarget) next.set(id, { ...row, selected });
  }
  return next;
}

export function toggleFleetRefreshRowExpanded(
  rows: ReadonlyMap<string, FleetRefreshRowState>,
  slotId: string,
): Map<string, FleetRefreshRowState> {
  const row = rows.get(slotId);
  if (!row) return new Map(rows);
  const next = new Map(rows);
  next.set(slotId, { ...row, expanded: !row.expanded });
  return next;
}

export function findFleetRefreshRowByRequestId(
  rows: Iterable<FleetRefreshRowState>,
  requestId: string,
): FleetRefreshRowState | undefined {
  for (const row of rows) {
    if (row.requestId && row.requestId === requestId) return row;
  }
  return undefined;
}

export function appendFleetRefreshRowLog(
  row: FleetRefreshRowState,
  output: string,
  options: { maxLines: number; tailTruncate: number },
): FleetRefreshRowState | null {
  const lines = output.split(/\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const newLog = [...row.log, ...lines];
  const trimmed = newLog.length > options.maxLines ? newLog.slice(-options.maxLines) : newLog;
  const tail = lines[lines.length - 1].slice(0, options.tailTruncate);
  return { ...row, log: trimmed, lastLogLine: tail };
}

export function fleetRefreshRunningProgress(
  rows: Iterable<FleetRefreshRowState>,
): FleetRefreshRunningProgress {
  let total = 0;
  let done = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.status !== 'idle') total += 1;
    if (
      row.status === 'refreshed' ||
      row.status === 'failed' ||
      row.status === 'skipped' ||
      row.status === 'cancelled'
    ) {
      done += 1;
    }
    if (row.status === 'failed') failed += 1;
  }
  return { total, done, failed };
}
