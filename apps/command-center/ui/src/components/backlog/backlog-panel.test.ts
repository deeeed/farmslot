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
  showsBacklogCleanupActionsForUi,
  syncedBacklogDraftProject,
} from './backlog-panel-model.js';

test('backlog default (all) filter hides archived items but the archived filter shows them', () => {
  // Store loads archived items (includeArchived), so the filter must hide them
  // from the default view while keeping them reachable under status=archived.
  assert.equal(backlogItemMatchesStatusFilter('archived', 'all'), false);
  assert.equal(backlogItemMatchesStatusFilter('ready', 'all'), true);
  assert.equal(backlogItemMatchesStatusFilter('done', 'all'), true);
  assert.equal(backlogItemMatchesStatusFilter('archived', 'archived'), true);
  assert.equal(backlogItemMatchesStatusFilter('ready', 'archived'), false);
  assert.equal(backlogItemMatchesStatusFilter('ready', 'ready'), true);
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
