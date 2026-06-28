import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BacklogItem } from '../../src/index.js';
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

test('backlog protocol carries optional roadmap spec metadata and tags', () => {
  const item = {
    id: 'backlog-1',
    project: 'farmslot-farm',
    title: 'Markdown spec',
    sourceKind: 'manual',
    sourceRef: 'MANUAL-000001',
    flowType: 'dev',
    status: 'candidate',
    notes: 'draft',
    tags: ['roadmap'],
    roadmapItemId: 'ri_123',
    specPath: '.backlog/specs/markdown-spec.md',
    priority: 10,
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
  } satisfies BacklogItem;

  assert.deepEqual(item.tags, ['roadmap']);
  assert.equal(item.roadmapItemId, 'ri_123');
  assert.equal(item.specPath, '.backlog/specs/markdown-spec.md');
});
