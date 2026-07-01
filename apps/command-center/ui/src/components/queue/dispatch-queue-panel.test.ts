import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BacklogItem, QueueItem } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import {
  isOrphanedBacklogQueueItemForUi,
  queueRemoveRequestForUi,
} from './dispatch-queue-panel-model.js';

function queueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'queue-1',
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-1',
    status: 'queued',
    priority: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    queueKind: 'dispatch',
    ...overrides,
  } as QueueItem;
}

test('queue panel orphan badge mirrors server dispatching guard', () => {
  const backlogItems = [{ id: 'backlog-1' }] as Pick<BacklogItem, 'id'>[];

  assert.equal(
    isOrphanedBacklogQueueItemForUi(
      queueItem({ backlogItemId: 'missing-backlog', status: 'queued' }),
      backlogItems,
    ),
    true,
  );
  assert.equal(
    isOrphanedBacklogQueueItemForUi(
      queueItem({ backlogItemId: 'missing-backlog', status: 'cancelled' }),
      backlogItems,
    ),
    true,
  );
  assert.equal(
    isOrphanedBacklogQueueItemForUi(
      queueItem({ backlogItemId: 'missing-backlog', status: 'dispatching' }),
      backlogItems,
    ),
    false,
  );
  assert.equal(
    isOrphanedBacklogQueueItemForUi(
      queueItem({ backlogItemId: 'backlog-1', status: 'queued' }),
      backlogItems,
    ),
    false,
  );
});

test('queue panel remove routing chooses backlog dequeue, orphan remove, or direct remove', () => {
  const backlogItems = [{ id: 'backlog-1' }] as Pick<BacklogItem, 'id'>[];

  assert.deepEqual(
    queueRemoveRequestForUi(
      queueItem({ id: 'queue-linked', backlogItemId: 'backlog-1' }),
      backlogItems,
    ),
    { method: Methods.BACKLOG_DEQUEUE, params: { itemId: 'backlog-1' } },
  );
  assert.deepEqual(
    queueRemoveRequestForUi(
      queueItem({ id: 'queue-orphan', backlogItemId: 'missing-backlog' }),
      backlogItems,
    ),
    { method: Methods.DISPATCH_QUEUE_REMOVE_ORPHAN, params: { itemId: 'queue-orphan' } },
  );
  assert.deepEqual(queueRemoveRequestForUi(queueItem({ id: 'queue-direct' }), backlogItems), {
    method: Methods.DISPATCH_QUEUE_REMOVE,
    params: { itemId: 'queue-direct' },
  });
});
