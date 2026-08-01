import {
  ARCHIVABLE_BACKLOG_STATUSES,
  BACKLOG_STATUSES,
  type BacklogItem,
  type BacklogRefineResult,
  type BacklogRefinementSessionGetResult,
  type BacklogStatus,
  isTerminalRunStatus,
  type Run,
} from '@farmslot/protocol';

import { linkedRunsForBacklogItems } from '../shared/linked-run-model.js';
import { syncedDraftProject } from '../shared/planning-projects.js';

export const BACKLOG_SORT_KEYS = [
  'status',
  'flow',
  'project',
  'ref',
  'title',
  'activity',
  'updated',
] as const;
export type BacklogSortKey = (typeof BACKLOG_SORT_KEYS)[number];
export type BacklogSortDirection = 'asc' | 'desc';

export function displayedBacklogFlow(item: BacklogItem, activeRun?: Run): string {
  return activeRun?.flowType || item.flowType;
}

export function displayedBacklogStatus(item: BacklogItem, linkedRun?: Run): BacklogStatus {
  if (!linkedRun || item.status === 'archived' || item.status === 'done') return item.status;
  if (linkedRun.status === 'done') return item.multiPr ? 'ready' : 'done';
  if (linkedRun.status === 'failed') return 'failed';
  if (
    linkedRun.status === 'cancelled' ||
    linkedRun.status === 'blocked' ||
    linkedRun.status === 'paused'
  ) {
    return 'needs-attention';
  }
  return 'running';
}

function comparisonValue(
  item: BacklogItem,
  linkedRun: Run | undefined,
  key: BacklogSortKey,
): string {
  const activeRun = linkedRun && !isTerminalRunStatus(linkedRun.status) ? linkedRun : undefined;
  switch (key) {
    case 'status':
      return displayedBacklogStatus(item, linkedRun);
    case 'flow':
      return displayedBacklogFlow(item, activeRun);
    case 'project':
      return item.project;
    case 'ref':
      return item.sourceRef;
    case 'title':
      return item.title;
    case 'activity':
      return activeRun ? `1:${activeRun.updatedAt}` : `0:${item.updatedAt}`;
    case 'updated':
      return item.updatedAt;
  }
}

export function sortBacklogItems(
  items: readonly BacklogItem[],
  runs: Run[],
  key: BacklogSortKey,
  direction: BacklogSortDirection,
  prelinkedRuns?: ReadonlyMap<string, Run | undefined>,
): BacklogItem[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  const linkedRuns =
    prelinkedRuns ??
    linkedRunsForBacklogItems(runs, items, {
      allowSourceRefInference: true,
    });
  const values = new Map(
    items.map((item) => {
      return [item.id, comparisonValue(item, linkedRuns.get(item.id), key)];
    }),
  );
  return [...items].sort((a, b) => {
    const primary = (values.get(a.id) ?? '').localeCompare(values.get(b.id) ?? '', undefined, {
      numeric: true,
      sensitivity: 'base',
    });
    if (primary !== 0) return primary * multiplier;
    return a.sourceRef.localeCompare(b.sourceRef, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

// An archived item plus everything archivable is what the cleanup actions act on.
const TERMINAL_CLEANUP_BACKLOG_STATUSES: ReadonlySet<BacklogItem['status']> = new Set([
  ...ARCHIVABLE_BACKLOG_STATUSES,
  'archived' as const,
]);

export function canDequeueBacklogItemForUi(item: Pick<BacklogItem, 'status'>): boolean {
  return item.status === 'queued' || item.status === 'dispatching';
}

export function canMarkReadyBacklogItemForUi(item: Pick<BacklogItem, 'status'>): boolean {
  return (
    item.status === 'candidate' || item.status === 'failed' || item.status === 'needs-attention'
  );
}

export function showsBacklogCleanupActionsForUi(item: Pick<BacklogItem, 'status'>): boolean {
  return TERMINAL_CLEANUP_BACKLOG_STATUSES.has(item.status);
}

export function canArchiveBacklogItemForUi(item: Pick<BacklogItem, 'status'>): boolean {
  return ARCHIVABLE_BACKLOG_STATUSES.has(item.status);
}

export function canRestoreBacklogItemForUi(item: Pick<BacklogItem, 'status'>): boolean {
  return item.status === 'archived';
}

export function canDeleteBacklogItemForUi(
  item: Pick<BacklogItem, 'status' | 'workGraphId' | 'workNodeId'>,
): boolean {
  if (item.workGraphId || item.workNodeId) return false;
  return showsBacklogCleanupActionsForUi(item) || item.status === 'candidate';
}

// Default status view: the "live" set — everything an operator can act on or
// watch. done/archived are opt-in via their chips (archived items are still
// loaded with includeArchived so the chip has data to show).
export const DEFAULT_BACKLOG_STATUS_FILTER: ReadonlySet<BacklogStatus> = new Set([
  'candidate',
  'ready',
  'queued',
  'dispatching',
  'running',
  'failed',
  'needs-attention',
]);

export function backlogItemMatchesStatusFilter(
  status: BacklogItem['status'],
  filter: ReadonlySet<BacklogStatus>,
): boolean {
  return filter.has(status);
}

export function backlogStatusCounts(
  items: readonly BacklogItem[],
  linkedRuns: ReadonlyMap<string, Run | undefined> = new Map(),
): Record<BacklogStatus, number> {
  const counts = Object.fromEntries(BACKLOG_STATUSES.map((status) => [status, 0])) as Record<
    BacklogStatus,
    number
  >;
  for (const item of items) counts[displayedBacklogStatus(item, linkedRuns.get(item.id))] += 1;
  return counts;
}

function sameStatusSet(a: ReadonlySet<BacklogStatus>, b: ReadonlySet<BacklogStatus>): boolean {
  return a.size === b.size && [...a].every((status) => b.has(status));
}

/** Hash param value for the status filter; null when the selection is the default view. */
export function serializeBacklogStatusFilter(filter: ReadonlySet<BacklogStatus>): string | null {
  if (sameStatusSet(filter, DEFAULT_BACKLOG_STATUS_FILTER)) return null;
  // An empty selection needs the `none` sentinel to survive reload — '' would
  // parse back as the default view.
  if (filter.size === 0) return 'none';
  // Canonical BACKLOG_STATUSES order keeps URLs stable regardless of click order.
  return BACKLOG_STATUSES.filter((status) => filter.has(status)).join(',');
}

/** Parse the hash param back to a status set; unknown tokens are dropped and an
 * absent/empty/invalid value falls back to the default view (also covers legacy
 * single-status links, which parse as a one-element set). */
export function parseBacklogStatusFilter(raw: string | null): ReadonlySet<BacklogStatus> {
  if (!raw?.trim()) return DEFAULT_BACKLOG_STATUS_FILTER;
  if (raw.trim() === 'none') return new Set();
  const valid = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token): token is BacklogStatus =>
      (BACKLOG_STATUSES as readonly string[]).includes(token),
    );
  return valid.length > 0 ? new Set(valid) : DEFAULT_BACKLOG_STATUS_FILTER;
}

export const syncedBacklogDraftProject = syncedDraftProject;

/** Pure view-model for the backlog "Refine with runner" picker launch/resume UI. */
export function backlogRefinementPickerView(state: {
  pickerOpen: boolean;
  selectedItemId: string;
  sessionLoadingItemId: string;
  existingSession: BacklogRefinementSessionGetResult | null;
}): {
  showPicker: boolean;
  showContinueExisting: boolean;
  showLoadingSession: boolean;
  primaryLaunchLabel: string;
  existingSessionId: string | null;
} {
  const existing =
    state.existingSession?.exists && state.existingSession.itemId === state.selectedItemId
      ? state.existingSession
      : null;
  return {
    showPicker: state.pickerOpen,
    showContinueExisting: Boolean(state.pickerOpen && existing),
    showLoadingSession:
      state.pickerOpen &&
      !existing &&
      state.sessionLoadingItemId === state.selectedItemId &&
      Boolean(state.selectedItemId),
    primaryLaunchLabel: existing ? 'Continue existing session' : 'Launch runner',
    existingSessionId: existing?.tmuxSession ?? null,
  };
}

/** Message shown after a refine RPC returns (launch vs resume vs prompt-only). */
export function backlogRefineResultMessage(result: BacklogRefineResult, launch: boolean): string {
  const selectedRunner = [result.runner, result.model, result.safetyTier]
    .filter(Boolean)
    .join(' ');
  const runnerSuffix = selectedRunner ? ` (${selectedRunner})` : '';
  if (!launch) return `Refinement prompt ready${runnerSuffix}: ${result.promptPath}`;
  if (result.launched) return `Refinement terminal launched${runnerSuffix}: ${result.attachCommand}`;
  return `Refinement terminal reopened${runnerSuffix}: ${result.attachCommand}`;
}
