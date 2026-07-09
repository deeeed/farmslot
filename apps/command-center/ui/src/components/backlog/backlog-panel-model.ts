import type { BacklogItem, BacklogStatus } from '@farmslot/protocol';

import { syncedDraftProject } from '../shared/planning-projects.js';

const ARCHIVABLE_BACKLOG_STATUSES = new Set<BacklogItem['status']>([
  'done',
  'failed',
  'needs-attention',
]);

const TERMINAL_CLEANUP_BACKLOG_STATUSES = new Set<BacklogItem['status']>([
  'done',
  'failed',
  'needs-attention',
  'archived',
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

// Whether an item passes the status filter. Archived items are soft-hidden:
// the store loads them (includeArchived) so the explicit `archived` filter can
// show them, but the default `all` view must exclude them.
export function backlogItemMatchesStatusFilter(
  status: BacklogItem['status'],
  filter: BacklogStatus | 'all',
): boolean {
  if (filter === 'all') return status !== 'archived';
  return status === filter;
}

export const syncedBacklogDraftProject = syncedDraftProject;
