import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BACKLOG_SOURCE_KINDS,
  BACKLOG_STATUSES,
  BacklogMethods,
  Events,
  Methods,
} from '../../src/index.js';

test('backlog protocol exports method constants and statuses', () => {
  assert.equal(Methods.BACKLOG_CREATE, 'backlog.create');
  assert.equal(BacklogMethods.enqueue, 'backlog.enqueue');
  assert.equal(Events.BACKLOG_UPDATED, 'backlog.updated');
  assert.deepEqual(BACKLOG_STATUSES, [
    'candidate',
    'ready',
    'queued',
    'dispatching',
    'running',
    'done',
    'failed',
    'needs-attention',
    'archived',
  ]);
  assert.deepEqual(BACKLOG_SOURCE_KINDS, ['jira', 'github', 'manual']);
});
