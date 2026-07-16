import {
  ARCHIVABLE_BACKLOG_STATUSES,
  BACKLOG_STATUSES,
  type BacklogItem,
  type BacklogStatus,
} from '@farmslot/protocol';

import { syncedDraftProject } from '../shared/planning-projects.js';

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

function sameStatusSet(a: ReadonlySet<BacklogStatus>, b: ReadonlySet<BacklogStatus>): boolean {
  return a.size === b.size && [...a].every((status) => b.has(status));
}

/** Hash param value for the status filter; null when the selection is the default view. */
export function serializeBacklogStatusFilter(filter: ReadonlySet<BacklogStatus>): string | null {
  if (sameStatusSet(filter, DEFAULT_BACKLOG_STATUS_FILTER)) return null;
  // Canonical BACKLOG_STATUSES order keeps URLs stable regardless of click order.
  return BACKLOG_STATUSES.filter((status) => filter.has(status)).join(',');
}

/** Parse the hash param back to a status set; unknown tokens are dropped and an
 * absent/empty/invalid value falls back to the default view (also covers legacy
 * single-status links, which parse as a one-element set). */
export function parseBacklogStatusFilter(raw: string | null): ReadonlySet<BacklogStatus> {
  if (!raw?.trim()) return DEFAULT_BACKLOG_STATUS_FILTER;
  const valid = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token): token is BacklogStatus =>
      (BACKLOG_STATUSES as readonly string[]).includes(token),
    );
  return valid.length > 0 ? new Set(valid) : DEFAULT_BACKLOG_STATUS_FILTER;
}

export const syncedBacklogDraftProject = syncedDraftProject;
