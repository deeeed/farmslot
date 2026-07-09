import type { BacklogItem } from '@farmslot/protocol';

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

export const syncedBacklogDraftProject = syncedDraftProject;
