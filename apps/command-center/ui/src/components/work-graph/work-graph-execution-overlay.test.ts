import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  BacklogItem,
  QueueItem,
  Run,
  SlotStatus,
  WorkGraphProjection,
} from '@farmslot/protocol';

import {
  buildSlotPendingWork,
  buildWorkGraphExecutionOverlay,
} from './work-graph-execution-overlay.js';

const now = '2026-06-29T00:00:00.000Z';

function backlog(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: 'backlog-1',
    project: 'farmslot-farm',
    title: 'Build graph overlay',
    sourceKind: 'manual',
    sourceRef: 'MANUAL-000001',
    flowType: 'dev',
    status: 'ready',
    priority: 10,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function graph(overrides: Partial<WorkGraphProjection> = {}): WorkGraphProjection {
  return {
    graph: {
      id: 'graph-1',
      version: 1,
      project: 'farmslot-farm',
      title: 'Graph overlay v1',
      source: { kind: 'manual' },
      status: 'active',
      defaultFailurePolicy: 'halt',
      scheduler: {},
      createdAt: now,
      updatedAt: now,
    },
    nodes: [
      {
        id: 'node-1',
        graphId: 'graph-1',
        kind: 'backlog',
        backlogItemId: 'backlog-1',
        status: 'ready',
        waitingOn: [],
        updatedAt: now,
      },
    ],
    edges: [],
    gates: [],
    ledger: [],
    ...overrides,
  };
}

function slot(overrides: Partial<SlotStatus> = {}): SlotStatus {
  return {
    slot: 'macwork-ff-1',
    machine: 'gohan',
    platform: 'mac',
    project: 'farmslot-farm',
    health: { ssh: 'OK', device: '-', devserver: '-', cdp: '-', fixtures: '-' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: true,
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: 'codex',
    model: 'gpt-5.5',
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
    ...overrides,
  };
}

function queue(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'queue-1',
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-000001',
    priority: 10,
    createdAt: now,
    status: 'queued',
    backlogItemId: 'backlog-1',
    workGraphId: 'graph-1',
    workNodeId: 'node-1',
    ...overrides,
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    lane: 'production',
    flowType: 'dev',
    status: 'monitoring',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-000001',
    slotId: 'macwork-ff-1',
    branch: 'main',
    taskFile: 'TASK.md',
    steps: [],
    decisions: [],
    metrics: { runner: 'codex', model: 'gpt-5.5', nudgeCount: 0 },
    createdAt: now,
    updatedAt: now,
    backlogItemId: 'backlog-1',
    workGraphId: 'graph-1',
    workNodeId: 'node-1',
    ...overrides,
  };
}

test('overlay marks a ready backlog node with visible candidate slots', () => {
  const overlay = buildWorkGraphExecutionOverlay({
    graph: graph(),
    backlogItems: [backlog()],
    queueItems: [],
    runs: [],
    slots: [slot()],
  });
  const node = overlay.byNodeId.get('node-1');
  assert.equal(node?.executionStatus, 'ready');
  assert.equal(node?.editableConfig, true);
  assert.equal(node?.visibleCandidateSlots[0]?.ready, true);
});

test('overlay explains queued work waiting for allowed busy slot', () => {
  const overlay = buildWorkGraphExecutionOverlay({
    graph: graph(),
    backlogItems: [backlog({ allowedSlots: ['macwork-ff-1'], queuedQueueItemId: 'queue-1' })],
    queueItems: [queue({ allowedSlots: ['macwork-ff-1'] })],
    runs: [],
    slots: [slot({ lifecycle: 'busy', phase: 'working', agent: 'working' })],
  });
  const node = overlay.byNodeId.get('node-1');
  assert.equal(node?.executionStatus, 'waiting-for-slot');
  assert.match(node?.blockers[0]?.message ?? '', /busy/);
});

test('overlay uses run state before queue state for active execution', () => {
  const overlay = buildWorkGraphExecutionOverlay({
    graph: graph(),
    backlogItems: [backlog({ queuedQueueItemId: 'queue-1', runId: 'run-1' })],
    queueItems: [queue()],
    runs: [run({ status: 'human-gating' })],
    slots: [slot({ lifecycle: 'busy', phase: 'review-gate', currentRunId: 'run-1' })],
  });
  assert.equal(overlay.byNodeId.get('node-1')?.executionStatus, 'gated');
});

test('slot pending work groups queued and running graph work by slot', () => {
  const pending = buildSlotPendingWork({
    slots: [slot(), slot({ slot: 'macwork-ff-2' })],
    backlogItems: [backlog()],
    queueItems: [queue({ allowedSlots: ['macwork-ff-2'] })],
    runs: [run()],
    workGraphs: [graph()],
  });
  assert.equal(pending.get('macwork-ff-1')?.running.length, 1);
  assert.equal(pending.get('macwork-ff-2')?.queued.length, 1);
});
