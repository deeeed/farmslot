import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BacklogStatus } from '@farmslot/protocol';

import { canDequeueBacklogItemForUi } from './backlog-panel-model.js';

test('backlog panel dequeue action is only enabled for queued dispatch lifecycle statuses', () => {
  const enabled: BacklogStatus[] = ['queued', 'dispatching'];
  const disabled: BacklogStatus[] = [
    'candidate',
    'ready',
    'running',
    'done',
    'failed',
    'needs-attention',
    'archived',
  ];

  for (const status of enabled) assert.equal(canDequeueBacklogItemForUi({ status }), true, status);
  for (const status of disabled)
    assert.equal(canDequeueBacklogItemForUi({ status }), false, status);
});
