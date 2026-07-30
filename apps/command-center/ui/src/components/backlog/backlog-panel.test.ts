import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BacklogItem, BacklogStatus, Run } from '@farmslot/protocol';

import {
  backlogItemMatchesStatusFilter,
  backlogStatusCounts,
  canArchiveBacklogItemForUi,
  canDeleteBacklogItemForUi,
  canDequeueBacklogItemForUi,
  canMarkReadyBacklogItemForUi,
  canRestoreBacklogItemForUi,
  DEFAULT_BACKLOG_STATUS_FILTER,
  displayedBacklogFlow,
  displayedBacklogStatus,
  parseBacklogStatusFilter,
  serializeBacklogStatusFilter,
  showsBacklogCleanupActionsForUi,
  sortBacklogItems,
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

test('backlog status counts keep hidden completed work discoverable', () => {
  const base = {
    project: 'metamask-core-farm',
    sourceKind: 'jira',
    sourceRef: 'TAT-1',
    title: 'Item',
    flowType: 'dev',
    priority: 10,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  } as const;
  const counts = backlogStatusCounts([
    { ...base, id: 'candidate', status: 'candidate' },
    { ...base, id: 'done-1', status: 'done' },
    { ...base, id: 'done-2', status: 'done' },
    { ...base, id: 'archived', status: 'archived' },
  ]);

  assert.equal(counts.candidate, 1);
  assert.equal(counts.done, 2);
  assert.equal(counts.archived, 1);
  assert.equal(counts.running, 0);
});

test('backlog status projection reconciles linked direct runs', () => {
  const item = {
    id: 'item',
    project: 'metamask-core-farm',
    sourceKind: 'jira',
    sourceRef: 'TAT-3252',
    title: 'Reduce-only order',
    flowType: 'fix-bug',
    status: 'candidate',
    priority: 10,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  } satisfies BacklogItem;
  const run = {
    id: 'run',
    project: item.project,
    ticketOrPr: item.sourceRef,
    status: 'human-gating',
    updatedAt: '2026-07-30T02:00:00.000Z',
  } as Run;

  assert.equal(displayedBacklogStatus(item, run), 'running');
  assert.equal(displayedBacklogStatus(item, { ...run, status: 'blocked' }), 'needs-attention');
  assert.equal(displayedBacklogStatus(item, { ...run, status: 'done' }), 'done');
  assert.equal(backlogStatusCounts([item], new Map([[item.id, run]])).running, 1);
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

  // An empty selection (every chip toggled off) round-trips via the 'none'
  // sentinel instead of snapping back to the default on reload.
  assert.equal(serializeBacklogStatusFilter(new Set()), 'none');
  assert.equal(parseBacklogStatusFilter('none').size, 0);

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

test('backlog activity sorting puts out-of-band active runs ahead of idle candidates', () => {
  const base = {
    project: 'metamask-core-farm',
    sourceKind: 'jira',
    flowType: 'dev',
    status: 'candidate',
    priority: 10,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  } as const;
  const idle = {
    ...base,
    id: 'idle',
    sourceRef: 'TAT-3400',
    title: 'Idle candidate',
  } satisfies BacklogItem;
  const active = {
    ...base,
    id: 'active',
    sourceRef: 'TAT-3343',
    title: 'Active candidate',
  } satisfies BacklogItem;
  const activeRun = {
    id: 'run-active',
    project: active.project,
    ticketOrPr: active.sourceRef,
    status: 'human-gating',
    updatedAt: '2026-07-30T02:00:00.000Z',
  } as Run;

  assert.deepEqual(
    sortBacklogItems([idle, active], [activeRun], 'activity', 'desc').map((item) => item.id),
    ['active', 'idle'],
  );
  assert.deepEqual(
    sortBacklogItems([idle, active], [activeRun], 'project', 'asc').map((item) => item.id),
    ['active', 'idle'],
  );
});

test('backlog displays and sorts by the active run flow when it differs from intake', () => {
  const devItem = {
    id: 'dev-item',
    project: 'metamask-core-farm',
    sourceKind: 'jira',
    sourceRef: 'TAT-3252',
    title: 'Reduce-only order would increase position',
    flowType: 'dev',
    status: 'candidate',
    priority: 10,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  } satisfies BacklogItem;
  const reviewItem = {
    ...devItem,
    id: 'review-item',
    sourceRef: 'TAT-3309',
    title: 'Review order book',
    flowType: 'review-pr',
  } satisfies BacklogItem;
  const activeRun = {
    id: 'run-active',
    project: devItem.project,
    ticketOrPr: devItem.sourceRef,
    flowType: 'fix-bug',
    status: 'human-gating',
    updatedAt: '2026-07-30T02:00:00.000Z',
  } as Run;

  assert.equal(displayedBacklogFlow(devItem), 'dev');
  assert.equal(displayedBacklogFlow(devItem, activeRun), 'fix-bug');
  assert.deepEqual(
    sortBacklogItems([reviewItem, devItem], [activeRun], 'flow', 'asc').map((item) => item.id),
    ['dev-item', 'review-item'],
  );
});

test('backlog activity sorting treats terminal linked runs as inactive', () => {
  const base = {
    project: 'metamask-core-farm',
    sourceKind: 'jira',
    flowType: 'dev',
    status: 'candidate',
    priority: 10,
    createdAt: '2026-07-30T00:00:00.000Z',
  } as const;
  const idle = {
    ...base,
    id: 'idle',
    sourceRef: 'TAT-3400',
    title: 'Idle candidate',
    updatedAt: '2026-07-30T02:00:00.000Z',
  } satisfies BacklogItem;
  const terminal = {
    ...base,
    id: 'terminal',
    sourceRef: 'TAT-3343',
    title: 'Terminal candidate',
    updatedAt: '2026-07-30T01:00:00.000Z',
  } satisfies BacklogItem;
  const terminalRun = {
    id: 'run-terminal',
    backlogItemId: terminal.id,
    project: terminal.project,
    ticketOrPr: terminal.sourceRef,
    status: 'done',
    updatedAt: '2026-07-30T03:00:00.000Z',
  } as Run;

  assert.deepEqual(
    sortBacklogItems([terminal, idle], [terminalRun], 'activity', 'desc').map((item) => item.id),
    ['idle', 'terminal'],
  );
});
