import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BacklogStatus } from '@farmslot/protocol';

import {
  backlogItemMatchesStatusFilter,
  canArchiveBacklogItemForUi,
  canDeleteBacklogItemForUi,
  canDequeueBacklogItemForUi,
  canMarkReadyBacklogItemForUi,
  canRestoreBacklogItemForUi,
  DEFAULT_BACKLOG_STATUS_FILTER,
  parseBacklogStatusFilter,
  serializeBacklogStatusFilter,
  showsBacklogCleanupActionsForUi,
  syncedBacklogDraftProject,
} from './backlog-panel-model.js';

test('backlog default filter shows the live set and hides done/archived', () => {
  // Store loads archived items (includeArchived), so the default view must hide
  // them while keeping them reachable by toggling their chip on.
  for (const live of [
    'candidate',
    'ready',
    'queued',
    'dispatching',
    'running',
    'failed',
    'needs-attention',
  ] as const) {
    assert.equal(backlogItemMatchesStatusFilter(live, DEFAULT_BACKLOG_STATUS_FILTER), true);
  }
  assert.equal(backlogItemMatchesStatusFilter('done', DEFAULT_BACKLOG_STATUS_FILTER), false);
  assert.equal(backlogItemMatchesStatusFilter('archived', DEFAULT_BACKLOG_STATUS_FILTER), false);
  assert.equal(
    backlogItemMatchesStatusFilter('archived', new Set<BacklogStatus>(['archived'])),
    true,
  );
  assert.equal(
    backlogItemMatchesStatusFilter('ready', new Set<BacklogStatus>(['archived'])),
    false,
  );
});

test('backlog status filter round-trips through the hash param', () => {
  // Default selection writes no param (clean URLs), and an absent param parses
  // back to the default.
  assert.equal(serializeBacklogStatusFilter(DEFAULT_BACKLOG_STATUS_FILTER), null);
  assert.deepEqual(
    [...parseBacklogStatusFilter(null)].sort(),
    [...DEFAULT_BACKLOG_STATUS_FILTER].sort(),
  );
  assert.deepEqual(
    [...parseBacklogStatusFilter('')].sort(),
    [...DEFAULT_BACKLOG_STATUS_FILTER].sort(),
  );

  // Non-default selections serialize in canonical BACKLOG_STATUSES order
  // regardless of insertion order, and parse back to the same set.
  const picked = new Set<BacklogStatus>(['done', 'candidate']);
  const serialized = serializeBacklogStatusFilter(picked);
  assert.equal(serialized, 'candidate,done');
  assert.deepEqual([...parseBacklogStatusFilter(serialized)].sort(), ['candidate', 'done']);

  // Legacy single-status links parse as a one-element set; unknown tokens are
  // dropped, and an all-invalid value falls back to the default view.
  assert.deepEqual([...parseBacklogStatusFilter('done')], ['done']);
  assert.deepEqual([...parseBacklogStatusFilter('done,bogus')], ['done']);
  assert.deepEqual(
    [...parseBacklogStatusFilter('all')].sort(),
    [...DEFAULT_BACKLOG_STATUS_FILTER].sort(),
  );
});

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

test('backlog panel mark-ready action is enabled for candidate, failed, and needs-attention', () => {
  const enabled: BacklogStatus[] = ['candidate', 'failed', 'needs-attention'];
  const disabled: BacklogStatus[] = [
    'ready',
    'queued',
    'dispatching',
    'running',
    'done',
    'archived',
  ];

  for (const status of enabled)
    assert.equal(canMarkReadyBacklogItemForUi({ status }), true, status);
  for (const status of disabled)
    assert.equal(canMarkReadyBacklogItemForUi({ status }), false, status);
});

test('backlog cleanup actions are shown for finished backlog items', () => {
  assert.equal(showsBacklogCleanupActionsForUi({ status: 'done' }), true);
  assert.equal(canArchiveBacklogItemForUi({ status: 'done' }), true);
  assert.equal(canDeleteBacklogItemForUi({ status: 'done' }), true);
  assert.equal(canRestoreBacklogItemForUi({ status: 'archived' }), true);
  assert.equal(canArchiveBacklogItemForUi({ status: 'archived' }), false);
  assert.equal(showsBacklogCleanupActionsForUi({ status: 'ready' }), false);
});

test('backlog draft project follows a single global project filter', () => {
  assert.equal(
    syncedBacklogDraftProject({
      currentProject: 'metamask-extension-farm',
      availableProjects: ['metamask-extension-farm', 'metamask-mobile-farm'],
      globalProjects: ['metamask-mobile-farm'],
    }),
    'metamask-mobile-farm',
  );
});

test('backlog draft project keeps current project without a single global project filter', () => {
  assert.equal(
    syncedBacklogDraftProject({
      currentProject: 'custom-farm',
      availableProjects: ['metamask-extension-farm', 'metamask-mobile-farm'],
      globalProjects: ['metamask-extension-farm', 'metamask-mobile-farm'],
    }),
    'custom-farm',
  );
});

test('backlog draft project falls back to the first available project', () => {
  assert.equal(
    syncedBacklogDraftProject({
      currentProject: '',
      availableProjects: ['metamask-core-farm'],
      globalProjects: [],
    }),
    'metamask-core-farm',
  );
});
