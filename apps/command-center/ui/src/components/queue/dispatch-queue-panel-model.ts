import type { BacklogItem, QueueItem } from '@farmslot/protocol';

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
