import type { BacklogItem } from '@farmslot/protocol';

import { syncedDraftProject } from '../shared/planning-projects.js';

export function canDequeueBacklogItemForUi(item: Pick<BacklogItem, 'status'>): boolean {
  return item.status === 'queued' || item.status === 'dispatching';
}

export const syncedBacklogDraftProject = syncedDraftProject;
