import assert from 'node:assert/strict';
import test from 'node:test';

import type { QueueItem, SlotStatus } from '@farmslot/protocol';

import { evalSuiteCapUsage, setEvalSuiteCap } from '../evals/suite-cap-store.js';
import { findAffinitySlot } from '../methods/dispatch.js';
import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import {
  addItem,
  buildQueuePreviewParams,
  canDispatchQueuedItemToSlot,
  getQueueSnapshot,
  listItems,
  removeItem,
  reorderItems,
  selectQueueDispatchSlot,
  updateItem,
} from './dispatch-queue.js';

async function cleanupRun(runId: string): Promise<void> {
  if (!getRun(runId)) {
    return;
  }
  updateRun(runId, {
    status: 'done',
    completedAt: new Date().toISOString(),
  });
  await deleteRun(runId);
}

test('buildQueuePreviewParams preserves family/lane/variant identity', () => {
  const item: QueueItem = {
    id: 'queue-1',
    flowType: 'review-pr',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-mobile#42',
    familyId: 'family-1',
    parentRunId: 'parent-1',
    familyRootTicketOrPr: 'PROJ-42',
    lane: 'comparison',
    variant: 'claude',
    priority: 1,
    createdAt: '2026-04-15T00:00:00.000Z',
    status: 'queued',
  };
  assert.deepEqual(buildQueuePreviewParams(item), {
    slotId: undefined,
    project: 'farmslot-farm',
    flowType: 'review-pr',
    ticketOrPr: 'example-org/example-mobile#42',
    familyId: 'family-1',
    lane: 'comparison',
    variant: 'claude',
    allowedSlots: undefined,
    targetBranch: undefined,
  });
});

test('buildQueuePreviewParams forwards branch as targetBranch for PR-bound flows', () => {
  const reviewItem: QueueItem = {
    id: 'queue-pr-bound',
    flowType: 'review-pr',
    project: 'farmslot-farm',
    ticketOrPr: 'owner/repo#42',
    branch: 'feat/proj-42',
    priority: 1,
    createdAt: '2026-04-25T00:00:00.000Z',
    status: 'queued',
  };
  assert.equal(buildQueuePreviewParams(reviewItem).targetBranch, 'feat/proj-42');

  // Non-PR flows ignore the branch — they want a clean main slot.
  const bugItem: QueueItem = { ...reviewItem, id: 'queue-bug', flowType: 'fix-bug' };
  assert.equal(buildQueuePreviewParams(bugItem).targetBranch, undefined);

  // Missing branch on a PR flow stays undefined rather than accidentally
  // bonusing the first empty-branch slot.
  const reviewNoBranch: QueueItem = { ...reviewItem, id: 'queue-no-branch', branch: null };
  assert.equal(buildQueuePreviewParams(reviewNoBranch).targetBranch, undefined);
});

test('addItem rejects an explicit empty allowedSlots list', () => {
  assert.throws(
    () =>
      addItem({
        flowType: 'fix-bug',
        project: 'farmslot-farm',
        ticketOrPr: 'PROJ-1',
        allowedSlots: [],
      }),
    /active slot filters resolved to no matching slots/,
  );
});

test('addItem preserves interactive dev policy fields for auto-dispatch', () => {
  const item = addItem({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'Sketch a flexible dev launch flow',
    mode: 'interactive',
    devInteractiveProfile: 'reviewed',
    initialContext: 'Sketch a flexible dev launch flow',
    devChecklist: ['Confirm desired branch', 'Validate completion path'],
  });
  try {
    assert.equal(item.mode, 'interactive');
    assert.equal(item.devInteractiveProfile, 'reviewed');
    assert.equal(item.initialContext, 'Sketch a flexible dev launch flow');
    assert.deepEqual(item.devChecklist, ['Confirm desired branch', 'Validate completion path']);
  } finally {
    removeItem(item.id);
  }
});

test('addItem preserves eval-cell metadata for queued matrix dispatch', () => {
  const item = addItem({
    queueKind: 'eval-cell',
    label: 'case one / candidate a',
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'EVAL-CASE-1',
    lane: 'comparison',
    variant: 'candidate-a',
    completionPolicy: 'artifact-only',
    evalCell: {
      capGroupId: 'suite-cap-1',
      suiteId: 'dataset-1',
      cellId: 'case-1:candidate-a',
      caseSelectionId: 'case-1',
      candidateId: 'candidate-a',
      candidateLabel: 'Candidate A',
      experimentId: 'experiment-1',
      experimentKey: 'experiment-key-1',
      experimentManifestPath: '/tmp/eval/experiment-manifest.json',
      trialId: 'cell-case-1-candidate-a',
      trialStartParams: {
        project: 'farmslot-farm',
        experimentManifestPath: '/tmp/eval/experiment-manifest.json',
        axes: {},
      },
    },
  });
  try {
    assert.equal(item.queueKind, 'eval-cell');
    assert.equal(item.label, 'case one / candidate a');
    assert.equal(item.evalCell?.capGroupId, 'suite-cap-1');
    assert.equal(item.evalCell?.trialId, 'cell-case-1-candidate-a');
    assert.equal(item.completionPolicy, 'artifact-only');
  } finally {
    removeItem(item.id);
  }
});

test('reorderItems rewrites queue priorities and listItems returns reordered ids', () => {
  const first = addItem({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-queue-1',
    priority: 10,
  });
  const second = addItem({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-queue-2',
    priority: 20,
  });
  try {
    const reordered = reorderItems([second.id, first.id]);
    assert.deepEqual(
      reordered
        .filter((item) => item.id === first.id || item.id === second.id)
        .map((item) => item.id),
      [second.id, first.id],
    );
    assert.deepEqual(
      listItems()
        .filter((item) => item.id === first.id || item.id === second.id)
        .map((item) => item.id),
      [second.id, first.id],
    );
  } finally {
    removeItem(first.id);
    removeItem(second.id);
  }
});

test('reorderItems preserves omitted queued item positions when reordering a subset', () => {
  const first = addItem({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-queue-partial-1',
    priority: 10,
  });
  const second = addItem({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-queue-partial-2',
    priority: 20,
  });
  const third = addItem({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-queue-partial-3',
    priority: 30,
  });
  try {
    const reordered = reorderItems([third.id, second.id]);
    assert.deepEqual(
      reordered
        .filter((item) => item.id === first.id || item.id === second.id || item.id === third.id)
        .map((item) => item.id),
      [first.id, third.id, second.id],
    );
  } finally {
    removeItem(first.id);
    removeItem(second.id);
    removeItem(third.id);
  }
});

test('updateItem allows pending slot reassignment but rejects dispatching items', () => {
  const item = addItem({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-queue-update',
    priority: 10,
  });
  try {
    const updated = updateItem({
      itemId: item.id,
      allowedSlots: ['slot-a', 'slot-b'],
      priority: 5,
    });
    assert.deepEqual(updated.allowedSlots, ['slot-a', 'slot-b']);
    assert.equal(updated.priority, 5);
    item.status = 'dispatching';
    assert.throws(
      () => updateItem({ itemId: item.id, allowedSlots: ['slot-c'] }),
      /item is dispatching/,
    );
  } finally {
    removeItem(item.id);
  }
});

test('evalSuiteCapUsage counts active runs and dispatching eval queue cells', async (t) => {
  const capGroupId = 'suite-cap-usage';
  await setEvalSuiteCap(capGroupId, 2, 'dataset-cap-usage');
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'EVAL-CAP',
    engineState: {
      evalExperiment: {
        capGroupId,
        suiteId: 'dataset-cap-usage',
        experimentId: 'experiment-cap',
        experimentKey: 'experiment-cap-key',
        experimentManifestPath: '/tmp/eval/manifest.json',
        packagePath: '/tmp/eval/package.json',
        candidateStrategyFingerprint: 'fingerprint-cap',
        trialId: 'trial-cap-1',
      },
    },
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, { status: 'monitoring' });
  const item = addItem({
    queueKind: 'eval-cell',
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'EVAL-CAP-2',
    evalCell: {
      capGroupId,
      suiteId: 'dataset-cap-usage',
      cellId: 'case-cap:candidate-cap',
      experimentId: 'experiment-cap',
      experimentManifestPath: '/tmp/eval/manifest.json',
      trialId: 'cell-cap-2',
      trialStartParams: {
        project: 'farmslot-farm',
        experimentManifestPath: '/tmp/eval/manifest.json',
        axes: {},
      },
    },
  });
  try {
    item.status = 'dispatching';
    const usage = evalSuiteCapUsage(capGroupId, getQueueSnapshot());
    assert.equal(usage.cap, 2);
    assert.equal(usage.active, 1);
    assert.equal(usage.dispatching, 1);
    assert.equal(usage.queued, 0);
  } finally {
    removeItem(item.id);
  }
});

test('addItem persists valid startRef only after shared comparison policy passes', () => {
  const item = addItem({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-1',
    familyId: 'family-start-ref',
    lane: 'comparison',
    variant: 'candidate-start-ref',
    completionPolicy: 'artifact-only',
    startRef: 'main',
  });
  try {
    assert.deepEqual(item.startRef, {
      requestedRef: 'main',
      source: { kind: 'manual' },
    });
  } finally {
    removeItem(item.id);
  }
});

test('addItem rejects direct prior-run startRef provenance', async (t) => {
  const baseline = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-1-prior-run',
  });
  t.after(() => cleanupRun(baseline.id));

  assert.throws(
    () =>
      addItem({
        flowType: 'dev',
        project: baseline.project,
        ticketOrPr: baseline.ticketOrPr,
        familyId: baseline.familyId,
        parentRunId: baseline.id,
        lane: 'comparison',
        variant: 'candidate-start-ref',
        completionPolicy: 'artifact-only',
        startRef: 'main',
        startRefSource: { kind: 'prior-run', runId: baseline.id },
      } as any),
    /eval\.experiment\.create \+ eval\.trial\.start/,
  );
});

test('addItem rejects invalid startRef policy before queue persistence', () => {
  assert.throws(
    () =>
      addItem({
        flowType: 'review-pr',
        project: 'farmslot-farm',
        ticketOrPr: 'PROJ-1',
        lane: 'comparison',
        variant: 'candidate-start-ref',
        completionPolicy: 'artifact-only',
        startRef: 'main',
      }),
    /dev\/fix-bug/,
  );
  assert.throws(
    () =>
      addItem({
        flowType: 'dev',
        project: 'farmslot-farm',
        ticketOrPr: 'PROJ-1',
        lane: 'comparison',
        completionPolicy: 'artifact-only',
        startRef: 'main',
      }),
    /explicit variant/,
  );
});

test('queue preview params can drive family-aware comparison affinity', () => {
  const item: QueueItem = {
    id: 'queue-2',
    flowType: 'review-pr',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-mobile#42',
    familyId: 'family-2',
    parentRunId: null,
    familyRootTicketOrPr: 'PROJ-42',
    lane: 'comparison',
    variant: 'codex',
    priority: 1,
    createdAt: '2026-04-15T00:00:00.000Z',
    status: 'queued',
  };
  const preview = buildQueuePreviewParams(item);
  const slot = {
    slot: 'held-slot',
    machine: 'demo',
    platform: 'cli',
    project: 'farmslot-farm',
    health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
    branch: 'review/example-org-example-mobile-42-codex',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'held',
    phase: 'ci-watch',
    warm: false,
    taskId: null,
    taskFile: null,
    currentRunId: 'old-run',
    currentFlowType: 'review-pr',
    currentTicketOrPr: 'example-org/example-mobile#42',
    currentMode: 'interactive',
    currentFamilyId: 'family-2',
    currentLane: 'comparison',
    currentVariant: 'codex',
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
  } as any;
  assert.equal(
    findAffinitySlot([slot], preview.project, preview.ticketOrPr, {
      familyId: preview.familyId,
      lane: preview.lane,
      variant: preview.variant,
    })?.slot,
    'held-slot',
  );
});

test('selectQueueDispatchSlot prefers identity-matching held comparison slot', () => {
  const item: QueueItem = {
    id: 'queue-3',
    flowType: 'review-pr',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-mobile#42',
    familyId: 'family-3',
    parentRunId: null,
    familyRootTicketOrPr: 'PROJ-42',
    lane: 'comparison',
    variant: 'claude',
    priority: 1,
    createdAt: '2026-04-15T00:00:00.000Z',
    status: 'queued',
  };
  const slots: SlotStatus[] = [
    {
      slot: 'ready-slot',
      machine: 'demo',
      platform: 'cli',
      project: 'farmslot-farm',
      health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
      branch: 'main',
      agent: 'idle',
      enabled: true,
      dispatchable: true,
      lifecycle: 'ready',
      phase: null,
      warm: false,
      taskId: null,
      taskFile: null,
      currentRunId: null,
      currentFlowType: null,
      currentTicketOrPr: null,
      currentMode: null,
      currentFamilyId: null,
      currentLane: null,
      currentVariant: null,
      dispatchedAt: null,
      completedAt: null,
      runner: 'claude',
      model: 'sonnet',
      deviceName: null,
      taskPhase: null,
      taskStepProgress: null,
    },
    {
      slot: 'held-slot',
      machine: 'demo',
      platform: 'cli',
      project: 'farmslot-farm',
      health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
      branch: 'review/example-org-example-mobile-42-claude',
      agent: 'idle',
      enabled: true,
      dispatchable: true,
      lifecycle: 'held',
      phase: 'ci-watch',
      warm: false,
      taskId: null,
      taskFile: null,
      currentRunId: 'old-run',
      currentFlowType: 'review-pr',
      currentTicketOrPr: 'example-org/example-mobile#42',
      currentMode: 'interactive',
      currentFamilyId: 'family-3',
      currentLane: 'comparison',
      currentVariant: 'claude',
      dispatchedAt: null,
      completedAt: null,
      runner: 'codex',
      model: 'gpt-5.5',
      deviceName: null,
      taskPhase: null,
      taskStepProgress: null,
    },
  ];
  assert.equal(selectQueueDispatchSlot(slots, item), 'held-slot');
});

test('selectQueueDispatchSlot avoids mismatched held comparison slot and falls back to ready slot', () => {
  const item: QueueItem = {
    id: 'queue-4',
    flowType: 'review-pr',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-mobile#42',
    familyId: 'family-4',
    parentRunId: null,
    familyRootTicketOrPr: 'PROJ-42',
    lane: 'comparison',
    variant: 'codex',
    priority: 1,
    createdAt: '2026-04-15T00:00:00.000Z',
    status: 'queued',
  };
  const slots: SlotStatus[] = [
    {
      slot: 'ready-slot',
      machine: 'demo',
      platform: 'cli',
      project: 'farmslot-farm',
      health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
      branch: 'main',
      agent: 'idle',
      enabled: true,
      dispatchable: true,
      lifecycle: 'ready',
      phase: null,
      warm: false,
      taskId: null,
      taskFile: null,
      currentRunId: null,
      currentFlowType: null,
      currentTicketOrPr: null,
      currentMode: null,
      currentFamilyId: null,
      currentLane: null,
      currentVariant: null,
      dispatchedAt: null,
      completedAt: null,
      runner: 'claude',
      model: 'sonnet',
      deviceName: null,
      taskPhase: null,
      taskStepProgress: null,
    },
    {
      slot: 'held-mismatch',
      machine: 'demo',
      platform: 'cli',
      project: 'farmslot-farm',
      health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
      branch: 'review/example-org-example-mobile-42-claude',
      agent: 'idle',
      enabled: true,
      dispatchable: true,
      lifecycle: 'held',
      phase: 'ci-watch',
      warm: false,
      taskId: null,
      taskFile: null,
      currentRunId: 'old-run',
      currentFlowType: 'review-pr',
      currentTicketOrPr: 'example-org/example-mobile#42',
      currentMode: 'interactive',
      currentFamilyId: 'family-other',
      currentLane: 'comparison',
      currentVariant: 'claude',
      dispatchedAt: null,
      completedAt: null,
      runner: 'codex',
      model: 'gpt-5.5',
      deviceName: null,
      taskPhase: null,
      taskStepProgress: null,
    },
  ];
  assert.equal(selectQueueDispatchSlot(slots, item), 'ready-slot');
});

test('selectQueueDispatchSlot spreads launch candidates away from active siblings when possible', async () => {
  const activeSibling = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-launch-spread',
    slotId: 'slot-a',
    launchGroupId: 'launch-group-1',
    launchPlanId: 'launch-plan-1',
    launchCandidateId: 'baseline',
    launchSlotPolicy: 'exact',
  });
  const slots = [
    {
      slot: 'slot-a',
      machine: 'demo',
      platform: 'cli',
      project: 'farmslot-farm',
      health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
      branch: 'main',
      agent: 'idle',
      enabled: true,
      dispatchable: true,
      lifecycle: 'ready',
      phase: null,
      warm: false,
      taskId: null,
      taskFile: null,
      currentRunId: null,
      currentFlowType: null,
      currentTicketOrPr: null,
      currentMode: null,
      currentFamilyId: null,
      currentLane: null,
      currentVariant: null,
      dispatchedAt: null,
      completedAt: null,
      runner: 'claude',
      model: 'sonnet',
      deviceName: null,
      taskPhase: null,
      taskStepProgress: null,
    },
    {
      slot: 'slot-b',
      machine: 'demo',
      platform: 'cli',
      project: 'farmslot-farm',
      health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
      branch: 'main',
      agent: 'idle',
      enabled: true,
      dispatchable: true,
      lifecycle: 'ready',
      phase: null,
      warm: false,
      taskId: null,
      taskFile: null,
      currentRunId: null,
      currentFlowType: null,
      currentTicketOrPr: null,
      currentMode: null,
      currentFamilyId: null,
      currentLane: null,
      currentVariant: null,
      dispatchedAt: null,
      completedAt: null,
      runner: 'claude',
      model: 'sonnet',
      deviceName: null,
      taskPhase: null,
      taskStepProgress: null,
    },
  ] as SlotStatus[];
  const item: QueueItem = {
    id: 'queue-launch-spread',
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-launch-spread',
    launchGroupId: 'launch-group-1',
    launchSlotPolicy: 'spread',
    allowedSlots: ['slot-a', 'slot-b'],
    priority: 1,
    createdAt: '2026-06-30T00:00:00.000Z',
    status: 'queued',
  };

  try {
    assert.equal(selectQueueDispatchSlot(slots, item), 'slot-b');
    assert.equal(selectQueueDispatchSlot(slots, { ...item, allowedSlots: ['slot-a'] }), 'slot-a');
  } finally {
    await cleanupRun(activeSibling.id);
  }
});

test('canDispatchQueuedItemToSlot accepts held affinity slots but rejects working slots', () => {
  assert.equal(
    canDispatchQueuedItemToSlot({
      slot: 'held-slot',
      machine: 'demo',
      platform: 'cli',
      project: 'farmslot-farm',
      health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
      branch: 'feature',
      agent: 'idle',
      enabled: true,
      dispatchable: true,
      lifecycle: 'held',
      phase: 'ci-watch',
      warm: false,
      taskId: null,
      taskFile: null,
      dispatchedAt: null,
      completedAt: null,
      runner: 'codex',
      model: 'gpt-5.5',
      deviceName: null,
      taskPhase: null,
      taskStepProgress: null,
    } as any),
    true,
  );
  assert.equal(
    canDispatchQueuedItemToSlot({
      slot: 'busy-slot',
      machine: 'demo',
      platform: 'cli',
      project: 'farmslot-farm',
      health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
      branch: 'feature',
      agent: 'working',
      enabled: true,
      dispatchable: true,
      lifecycle: 'held',
      phase: 'ci-watch',
      warm: false,
      taskId: null,
      taskFile: null,
      dispatchedAt: null,
      completedAt: null,
      runner: 'codex',
      model: 'gpt-5.5',
      deviceName: null,
      taskPhase: null,
      taskStepProgress: null,
    } as any),
    false,
  );
});

test('addItem preserves selected worker template version for queue parity', () => {
  const item = addItem({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4242',
    taskTemplate: { fileName: 'fix-bug-v2.md', variant: 'v2' },
  });
  try {
    assert.deepEqual(item.taskTemplate, { fileName: 'fix-bug-v2.md', variant: 'v2' });
  } finally {
    removeItem(item.id);
  }
});
