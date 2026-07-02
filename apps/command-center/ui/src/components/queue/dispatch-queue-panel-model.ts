import { type BacklogItem, Methods, type QueueItem } from '@farmslot/protocol';

// Keep this in sync with isOrphanedBacklogQueueItem in services/gateway/src/backlog/store.ts.
export function isOrphanedBacklogQueueItemForUi(
  item: QueueItem,
  backlogItems: readonly Pick<BacklogItem, 'id'>[],
): boolean {
  return (
    item.status !== 'dispatching' &&
    Boolean(item.backlogItemId) &&
    !backlogItems.some((candidate) => candidate.id === item.backlogItemId)
  );
}

export function queueRemoveRequestForUi(
  item: QueueItem,
  backlogItems: readonly Pick<BacklogItem, 'id'>[],
): { method: string; params: { itemId: string } } {
  if (!item.backlogItemId)
    return { method: Methods.DISPATCH_QUEUE_REMOVE, params: { itemId: item.id } };
  const backlog = backlogItems.find((candidate) => candidate.id === item.backlogItemId);
  if (backlog) return { method: Methods.BACKLOG_DEQUEUE, params: { itemId: item.backlogItemId } };
  return { method: Methods.DISPATCH_QUEUE_REMOVE_ORPHAN, params: { itemId: item.id } };
}
