import assert from 'node:assert/strict';
import test from 'node:test';

import type { QueueItem, SlotStatus } from '@farmslot/protocol';

import { evalSuiteCapUsage, setEvalSuiteCap } from '../evals/suite-cap-store.js';
import { setCachedFleetForTests } from '../fleet/state.js';
import { findAffinitySlot } from '../methods/dispatch.js';
import {
  createRun,
  deleteRun,
  getAllRuns,
  getRun,
  persistRunNow,
  updateRun,
} from '../runs/store.js';

import {
  addItem,
  assertQueueClaimHeld,
  buildQueuePreviewParams,
  cancelGraphQueuedItem,
  canDispatchQueuedItemToSlot,
  claimQueueItem,
  getQueueSnapshot,
  initDispatchQueue,
  isQueueClaimHeld,
  listItems,
  loadQueue,
  mutateQueueItemForTests,
  persistQueueNow,
  QueueClaimLostError,
  reclaimExpiredClaims,
  releaseQueueClaim,
  removeItem,
  removeQueueItemInternal,
  removeQueueItemInternalNow,
  reorderItems,
  selectQueueDispatchSlot,
  setQueueDispatchPressureCaptureForTests,
  stampQueueItemRunId,
  stampQueueItemRunIdNow,
  tryDispatchNext,
  updateItem,
} from './dispatch-queue.js';

/** Slot-selection fixtures predate pressure admission: admit every machine so
 * the existing scoring/identity assertions stay deterministic. Pressure-hold
 * behavior has its own coverage in methods/dispatch/preview.test.ts. */
const admitAllPressure: NonNullable<
  Parameters<typeof selectQueueDispatchSlot>[2]
>['capturePressure'] = async (machines) =>
  new Map(
    machines.map((machine) => [
      machine,
      {
        outcome: 'admitted' as const,
        machine,
        state: 'green' as const,
        evidence: {
          machine,
          generation: `${machine}|test|1|2026-04-15T00:00:00.000Z`,
          evaluatedAt: '2026-04-15T00:00:00.000Z',
          samples: [],
          consecutiveCriticalSamples: 0,
          requiredConsecutiveCriticalSamples: 3,
          staleAfterMs: 150_000,
          latestSampleAt: '2026-04-15T00:00:00.000Z',
        },
      },
    ]),
  );

function selectSlotAdmitted(
  slots: Parameters<typeof selectQueueDispatchSlot>[0],
  item: Parameters<typeof selectQueueDispatchSlot>[1],
) {
  return selectQueueDispatchSlot(slots, item, { capturePressure: admitAllPressure });
}

// tryDispatchNext reaches selectQueueDispatchSlot internally. Stub the
// capture globally so auto-dispatch tests never touch the live snapshot path.
setQueueDispatchPressureCaptureForTests(admitAllPressure);

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
    mode: 'autonomous',
    domain: 'trading',
    executionTemplateId: 'review-pr/autonomous.extension',
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
    mode: 'autonomous',
    domain: 'trading',
    executionTemplateId: 'review-pr/autonomous.extension',
    app: undefined,
    prepareProfile: undefined,
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
      addItem(
        {
          flowType: 'fix-bug',
          project: 'farmslot-farm',
          ticketOrPr: 'PROJ-1',
          allowedSlots: [],
        },
        { kind: 'system' },
      ),
    /active slot filters resolved to no matching slots/,
  );
});

test('addItem preserves interactive dev policy fields for auto-dispatch', () => {
  const item = addItem(
    {
      flowType: 'dev',
      project: 'farmslot-farm',
      ticketOrPr: 'Sketch a flexible dev launch flow',
      mode: 'interactive',
      devInteractiveProfile: 'reviewed',
      initialContext: 'Sketch a flexible dev launch flow',
      devChecklist: ['Confirm desired branch', 'Validate completion path'],
    },
    { kind: 'system' },
  );
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
  const item = addItem(
    {
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
    },
    { kind: 'system' },
  );
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
  const first = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-queue-1',
      priority: 10,
    },
    { kind: 'system' },
  );
  const second = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-queue-2',
      priority: 20,
    },
    { kind: 'system' },
  );
  try {
    const reordered = reorderItems([second.id, first.id], { kind: 'system' });
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
  const first = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-queue-partial-1',
      priority: 10,
    },
    { kind: 'system' },
  );
  const second = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-queue-partial-2',
      priority: 20,
    },
    { kind: 'system' },
  );
  const third = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-queue-partial-3',
      priority: 30,
    },
    { kind: 'system' },
  );
  try {
    const reordered = reorderItems([third.id, second.id], { kind: 'system' });
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
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-queue-update',
      priority: 10,
    },
    { kind: 'system' },
  );
  try {
    const updated = updateItem(
      {
        itemId: item.id,
        allowedSlots: ['slot-a', 'slot-b'],
        priority: 5,
      },
      { kind: 'system' },
    );
    assert.deepEqual(updated.allowedSlots, ['slot-a', 'slot-b']);
    assert.equal(updated.priority, 5);
    mutateQueueItemForTests(item.id, (record) => {
      record.status = 'dispatching';
    });
    assert.throws(
      () => updateItem({ itemId: item.id, allowedSlots: ['slot-c'] }, { kind: 'system' }),
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
  const item = addItem(
    {
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
    },
    { kind: 'system' },
  );
  try {
    mutateQueueItemForTests(item.id, (record) => {
      record.status = 'dispatching';
    });
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
  const item = addItem(
    {
      flowType: 'dev',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-1',
      familyId: 'family-start-ref',
      lane: 'comparison',
      variant: 'candidate-start-ref',
      completionPolicy: 'artifact-only',
      startRef: 'main',
    },
    { kind: 'system' },
  );
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
      addItem(
        {
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
        } as any,
        { kind: 'system' },
      ),
    /eval\.experiment\.create \+ eval\.trial\.start/,
  );
});

test('addItem rejects invalid startRef policy before queue persistence', () => {
  assert.throws(
    () =>
      addItem(
        {
          flowType: 'review-pr',
          project: 'farmslot-farm',
          ticketOrPr: 'PROJ-1',
          lane: 'comparison',
          variant: 'candidate-start-ref',
          completionPolicy: 'artifact-only',
          startRef: 'main',
        },
        { kind: 'system' },
      ),
    /dev\/fix-bug/,
  );
  assert.throws(
    () =>
      addItem(
        {
          flowType: 'dev',
          project: 'farmslot-farm',
          ticketOrPr: 'PROJ-1',
          lane: 'comparison',
          completionPolicy: 'artifact-only',
          startRef: 'main',
        },
        { kind: 'system' },
      ),
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

test('selectQueueDispatchSlot prefers identity-matching held comparison slot', async () => {
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
    prepareProfile: 'sandbox',
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
  assert.equal(await selectSlotAdmitted(slots, item), 'held-slot');
});

test('selectQueueDispatchSlot avoids mismatched held comparison slot and falls back to ready slot', async () => {
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
    prepareProfile: 'sandbox',
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
  assert.equal(await selectSlotAdmitted(slots, item), 'ready-slot');
});

function plainCliSlot(slotId: string): SlotStatus {
  return {
    slot: slotId,
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
  };
}

test('selectQueueDispatchSlot never stamps profileFit onto unset prepareProfile', async () => {
  const item: QueueItem = {
    id: 'queue-no-stamp',
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'Command Center companion gateway task that exposes inventory',
    priority: 1,
    createdAt: '2026-04-15T00:00:00.000Z',
    status: 'queued',
    ticketData: {
      source: 'manual',
      title: 'Command Center inventory tables',
      description: 'UI that exposes inventory and companion pairing on gateway reconnect.',
      acceptanceCriteria: ['Tables render'],
      affectedArea: 'command-center',
      stepsToReproduce: [],
      screenshots: [],
      labels: ['command-center'],
    },
  };
  const slots = [plainCliSlot('plain-cli')];

  assert.equal(item.prepareProfile, undefined);
  assert.equal(await selectSlotAdmitted(slots, item), 'plain-cli');
  assert.equal(item.prepareProfile, undefined);
});

test('selectQueueDispatchSlot ignores exposes false-positive companion tokens when prepare unset', async () => {
  // "exposes" contains substring "expo" — old profile-fit stamp forced sandbox-companion.
  const item: QueueItem = {
    id: 'queue-exposes',
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-000074',
    priority: 1,
    createdAt: '2026-04-15T00:00:00.000Z',
    status: 'queued',
    ticketData: {
      source: 'manual',
      title: 'Command Center inventory tables',
      description: 'The runs page exposes inventory tables in Command Center.',
      acceptanceCriteria: ['Table exposes columns'],
      affectedArea: 'command-center',
      stepsToReproduce: [],
      screenshots: [],
      labels: ['command-center'],
    },
  };
  const slots = [plainCliSlot('mini-ff-2')];

  assert.equal(await selectSlotAdmitted(slots, item), 'mini-ff-2');
  assert.equal(item.prepareProfile, undefined);
});

test('selectQueueDispatchSlot preserves explicit sandbox prepareProfile despite companion ticket tokens', async () => {
  const item: QueueItem = {
    id: 'queue-explicit-sandbox',
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'companion mobile simulator pairing gateway task',
    prepareProfile: 'sandbox',
    priority: 1,
    createdAt: '2026-04-15T00:00:00.000Z',
    status: 'queued',
    ticketData: {
      source: 'manual',
      title: 'Companion pairing on mobile simulator',
      description: 'apps/companion expo metro pairing with gateway',
      acceptanceCriteria: ['Companion shows connected'],
      affectedArea: 'mobile companion',
      stepsToReproduce: [],
      screenshots: [],
      labels: ['companion'],
    },
  };
  const slots = [plainCliSlot('plain-cli')];

  assert.equal(await selectSlotAdmitted(slots, item), 'plain-cli');
  assert.equal(item.prepareProfile, 'sandbox');
});

test('selectQueueDispatchSlot still gates explicit sandbox-companion to simulator resources', async () => {
  const item: QueueItem = {
    id: 'queue-explicit-companion',
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'companion gateway task',
    prepareProfile: 'sandbox-companion',
    priority: 1,
    createdAt: '2026-04-15T00:00:00.000Z',
    status: 'queued',
  };
  const slots = [plainCliSlot('plain-cli')];

  await assert.rejects(
    () => selectSlotAdmitted(slots, item),
    /No free slots for project farmslot-farm have resources required by prepare profile sandbox-companion/,
  );
  assert.equal(item.prepareProfile, 'sandbox-companion');
});

test('selectQueueDispatchSlot does not defer bare GitHub refs when prepare is unset', async () => {
  const item: QueueItem = {
    id: 'queue-metadata-miss',
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-mobile#424242',
    priority: 1,
    createdAt: '2026-04-15T00:00:00.000Z',
    status: 'queued',
  };
  const slots = [plainCliSlot('plain-cli')];

  // Profile-fit no longer drives queue selection, so missing ticket metadata is not a stall.
  assert.equal(await selectSlotAdmitted(slots, item), 'plain-cli');
  assert.equal(item.prepareProfile, undefined);
});

test('selectQueueDispatchSlot does not defer non-farmslot queues on unavailable metadata', async () => {
  const item: QueueItem = {
    id: 'queue-other-project',
    flowType: 'pr-complete',
    project: 'metamask-mobile-farm',
    ticketOrPr: 'example-org/example-mobile#424242',
    priority: 1,
    createdAt: '2026-04-15T00:00:00.000Z',
    status: 'queued',
  };
  const slots: SlotStatus[] = [
    {
      slot: 'mm-cli',
      machine: 'demo',
      platform: 'cli',
      project: 'metamask-mobile-farm',
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
  ];

  assert.equal(await selectSlotAdmitted(slots, item), 'mm-cli');
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
    assert.equal(await selectSlotAdmitted(slots, item), 'slot-b');
    assert.equal(
      await selectQueueDispatchSlot(slots, { ...item, allowedSlots: ['slot-a'] }),
      'slot-a',
    );
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
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-4242',
      taskTemplate: { fileName: 'fix-bug-v2.md', variant: 'v2' },
    },
    { kind: 'system' },
  );
  try {
    assert.deepEqual(item.taskTemplate, { fileName: 'fix-bug-v2.md', variant: 'v2' });
  } finally {
    removeItem(item.id);
  }
});

test('tryDispatchNext skips queue items removed while fleet status is loading', async () => {
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-dispatch-race',
      allowedSlots: ['race-slot'],
    },
    { kind: 'system' },
  );
  let createdRuns = 0;
  initDispatchQueue(
    () => {},
    async (_item, claim) => {
      assertQueueClaimHeld(claim, 'test-create');
      createdRuns += 1;
    },
  );
  setCachedFleetForTests({
    checkedAt: '2026-07-02T00:00:00.000Z',
    slots: [
      {
        slot: 'race-slot',
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
        runner: null,
        model: null,
        deviceName: null,
        taskPhase: null,
        taskStepProgress: null,
      },
    ],
    summary: {
      total: 1,
      ready: 1,
      busy: 0,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
  });

  const dispatch = tryDispatchNext();
  removeItem(item.id);
  await dispatch;

  assert.equal(createdRuns, 0);
  assert.equal(
    getQueueSnapshot().some((candidate) => candidate.id === item.id),
    false,
  );
});

// ─── Exclusive claim protocol (MANUAL-000053) ───

const readyFleetSlot = (slotId: string) =>
  ({
    checkedAt: '2026-07-02T00:00:00.000Z',
    slots: [
      {
        slot: slotId,
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
        runner: null,
        model: null,
        deviceName: null,
        taskPhase: null,
        taskStepProgress: null,
      },
    ],
    summary: {
      total: 1,
      ready: 1,
      busy: 0,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
  }) as const;

test('claimQueueItem records exclusive holder and rejects a second claimer', () => {
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-claim-exclusive',
    },
    { kind: 'system' },
  );
  try {
    const claimA = claimQueueItem(item.id, 'holder-a');
    assert.ok(claimA);
    assert.equal(claimA.holderId, 'holder-a');
    assert.equal(claimA.epoch, 1);
    const claimed = getQueueSnapshot().find((record) => record.id === item.id);
    assert.equal(claimed?.status, 'dispatching');
    assert.equal(claimed?.claimHolder, 'holder-a');
    assert.equal(claimed?.claimEpoch, 1);
    assert.ok(claimed?.claimExpiresAt);
    assert.equal(isQueueClaimHeld(claimA), true);

    const claimB = claimQueueItem(item.id, 'holder-b');
    assert.equal(claimB, null, 'second claimer must not steal a held claim');
    assert.equal(isQueueClaimHeld(claimA), true);
  } finally {
    if (getQueueSnapshot().some((q) => q.id === item.id)) {
      removeQueueItemInternal(item.id, 'test-cleanup');
    }
  }
});

test('isQueueClaimHeld is false after revoke/remove and after expiry', () => {
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-claim-revoke',
    },
    { kind: 'system' },
  );
  const claim = claimQueueItem(item.id, 'holder-revoke', { ttlMs: 60_000 });
  assert.ok(claim);
  removeQueueItemInternal(item.id, 'test-revoke');
  assert.equal(isQueueClaimHeld(claim), false);

  const item2 = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-claim-expire',
    },
    { kind: 'system' },
  );
  try {
    const short = claimQueueItem(item2.id, 'holder-expire', { ttlMs: 1 });
    assert.ok(short);
    // Force expiry without waiting on a timer.
    assert.equal(isQueueClaimHeld(short, Date.parse(short.expiresAt) + 1), false);
    assert.equal(isQueueClaimHeld(short, Date.parse(short.expiresAt) - 1), true);
  } finally {
    if (getQueueSnapshot().some((q) => q.id === item2.id)) {
      removeQueueItemInternal(item2.id, 'test-cleanup');
    }
  }
});

test('cancelGraphQueuedItem commits dependent with removal and restores on dependent failure', async () => {
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-claim-atomic',
      workGraphId: 'wg_atomic',
      workNodeId: 'wn_atomic',
    },
    { kind: 'system' },
  );
  let dependentRan = false;
  const cancelled = await cancelGraphQueuedItem({
    workGraphId: 'wg_atomic',
    workNodeId: 'wn_atomic',
    reason: 'test-atomic-ok',
    commitDependent: async () => {
      dependentRan = true;
    },
  });
  assert.equal(cancelled, true);
  assert.equal(dependentRan, true);
  assert.equal(
    getQueueSnapshot().some((q) => q.id === item.id),
    false,
  );

  const item2 = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-claim-atomic-fail',
      workGraphId: 'wg_atomic_fail',
      workNodeId: 'wn_atomic_fail',
    },
    { kind: 'system' },
  );
  await assert.rejects(
    () =>
      cancelGraphQueuedItem({
        workGraphId: 'wg_atomic_fail',
        workNodeId: 'wn_atomic_fail',
        reason: 'test-atomic-fail',
        commitDependent: async () => {
          throw new Error('dependent failed');
        },
      }),
    /dependent failed/,
  );
  assert.ok(
    getQueueSnapshot().some((q) => q.id === item2.id && q.status === 'queued'),
    'row restored when dependent fails',
  );
  removeItem(item2.id);
});

test('cancelGraphQueuedItem revokes a claimed dispatching row', async () => {
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-claim-cancel-dispatching',
      workGraphId: 'wg_cancel_claim',
      workNodeId: 'wn_cancel_claim',
    },
    { kind: 'system' },
  );
  const claim = claimQueueItem(item.id, 'holder-cancel');
  assert.ok(claim);
  assert.equal(getQueueSnapshot().find((record) => record.id === item.id)?.status, 'dispatching');

  const cancelled = await cancelGraphQueuedItem({
    workGraphId: 'wg_cancel_claim',
    workNodeId: 'wn_cancel_claim',
    reason: 'test-cancel-claimed',
  });
  assert.equal(cancelled, true);
  assert.equal(isQueueClaimHeld(claim), false);
  assert.equal(
    getQueueSnapshot().some((q) => q.id === item.id),
    false,
  );
});

test('a dispatcher holding a revoked claim creates no Run', async () => {
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-claim-revoked-no-run',
      allowedSlots: ['claim-slot'],
      workGraphId: 'wg_revoked',
      workNodeId: 'wn_revoked',
    },
    { kind: 'system' },
  );
  let createdRuns = 0;
  initDispatchQueue(
    () => {},
    async (_item, claim) => {
      assertQueueClaimHeld(claim, 'test-create');
      createdRuns += 1;
    },
  );

  // Claim, then concurrent reclaim revokes before createRun re-validation.
  const claim = claimQueueItem(item.id, 'holder-revoked');
  assert.ok(claim);
  await cancelGraphQueuedItem({
    workGraphId: 'wg_revoked',
    workNodeId: 'wn_revoked',
    reason: 'reclaim-wins',
  });
  assert.throws(() => assertQueueClaimHeld(claim, 'test'), QueueClaimLostError);
  assert.equal(createdRuns, 0, 'revoked claim must not create a Run');
  assert.equal(isQueueClaimHeld(claim), false);

  // Integration: pre-claim then revoke so tryDispatchNext cannot create.
  const item2 = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-claim-revoked-dispatch',
      allowedSlots: ['claim-slot'],
      workGraphId: 'wg_revoked2',
      workNodeId: 'wn_revoked2',
    },
    { kind: 'system' },
  );
  createdRuns = 0;
  setCachedFleetForTests(readyFleetSlot('claim-slot') as any);

  const preClaim = claimQueueItem(item2.id, 'pre-holder');
  assert.ok(preClaim);
  removeQueueItemInternal(item2.id, 'revoke-pre-claim');
  assert.equal(isQueueClaimHeld(preClaim), false);
  await tryDispatchNext();
  assert.equal(createdRuns, 0);
});

test('concurrent reclaim and dispatch against one row creates exactly one Run', async (t) => {
  // Production-shaped path: tryDispatchNext → claim → pause → real createRun +
  // persistRunNow + removeQueueItemInternalNow. Concurrent cancel during the pause
  // must yield 0 or 1 actual Run records — never two.
  setCachedFleetForTests(readyFleetSlot('real-race-slot') as any);
  const _item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-claim-concurrent',
      allowedSlots: ['real-race-slot'],
      workGraphId: 'wg_concurrent',
      workNodeId: 'wn_concurrent',
      autoDispatch: false,
    },
    { kind: 'system' },
  );
  void _item;
  const createdRunIds: string[] = [];
  let releaseGate: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let enteredCreate = false;
  let signalEntered: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });

  initDispatchQueue(
    () => {},
    async (qi, claim) => {
      enteredCreate = true;
      signalEntered();
      // Pause after claim, before durable create — reclaim races here.
      await gate;
      assertQueueClaimHeld(claim, 'pre-durable-createRun');
      const run = createRun({
        flowType: qi.flowType,
        project: qi.project,
        ticketOrPr: qi.ticketOrPr,
        workGraphId: qi.workGraphId,
        workNodeId: qi.workNodeId,
      });
      await persistRunNow(run, 'test-claim-race');
      createdRunIds.push(run.id);
      qi.runId = run.id;
      await removeQueueItemInternalNow(qi.id, 'dispatch-created');
    },
  );

  t.after(async () => {
    for (const id of createdRunIds) {
      await cleanupRun(id);
    }
  });

  const dispatch = tryDispatchNext();
  await Promise.race([entered, new Promise((r) => setTimeout(r, 1000))]);
  assert.equal(enteredCreate, true, 'create callback must enter (fleet+claim path)');

  // Concurrent reclaim while create is paused after claim.
  const reclaimPromise = cancelGraphQueuedItem({
    workGraphId: 'wg_concurrent',
    workNodeId: 'wn_concurrent',
    reason: 'concurrent-reclaim',
  });
  releaseGate!();
  await Promise.all([dispatch, reclaimPromise]);

  assert.ok(createdRunIds.length <= 1, `expected at most one Run, got ${createdRunIds.length}`);
  // Reclaim during the pre-create gate: claim lost → 0 Runs.
  assert.equal(createdRunIds.length, 0, 'reclaim before durable create yields no Run');
  const liveForNode = getAllRuns().filter(
    (run) =>
      run.workNodeId === 'wn_concurrent' && !['done', 'cancelled', 'failed'].includes(run.status),
  );
  assert.equal(liveForNode.length, 0);

  // Create-wins path: claim, create real Run, then reclaim finds nothing.
  const _item2 = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-claim-create-wins',
      allowedSlots: ['real-race-slot'],
      workGraphId: 'wg_create_wins',
      workNodeId: 'wn_create_wins',
      autoDispatch: false,
    },
    { kind: 'system' },
  );
  void _item2;
  const createdWins: string[] = [];
  initDispatchQueue(
    () => {},
    async (qi, claim) => {
      assertQueueClaimHeld(claim, 'pre-durable-createRun');
      const run = createRun({
        flowType: qi.flowType,
        project: qi.project,
        ticketOrPr: qi.ticketOrPr,
        workGraphId: qi.workGraphId,
        workNodeId: qi.workNodeId,
      });
      await persistRunNow(run, 'test-create-wins');
      createdWins.push(run.id);
      qi.runId = run.id;
      await removeQueueItemInternalNow(qi.id, 'dispatch-created');
    },
  );
  t.after(async () => {
    for (const id of createdWins) {
      await cleanupRun(id);
    }
  });
  await tryDispatchNext();
  assert.equal(createdWins.length, 1, 'dispatch creates exactly one Run');
  assert.ok(getRun(createdWins[0]));
  // Reclaim after handoff finds no row.
  const cancelledAfter = await cancelGraphQueuedItem({
    workGraphId: 'wg_create_wins',
    workNodeId: 'wn_create_wins',
    reason: 'after-create',
  });
  assert.equal(cancelledAfter, false);
  assert.equal(createdWins.length, 1, 'still exactly one Run after late reclaim');
});

test('assertQueueClaimHeld rejects after claim revoke/remove on the primitives', async () => {
  // Primitive-level guard: claim + remove + assert. Production tryDispatchNext
  // re-validation is covered by
  // `concurrent reclaim and dispatch against one row creates exactly one Run`.
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-claim-revalidate',
      allowedSlots: ['revalidate-slot'],
      workGraphId: 'wg_revalidate',
      workNodeId: 'wn_revalidate',
    },
    { kind: 'system' },
  );
  let createdRuns = 0;
  initDispatchQueue(
    () => {},
    async (_item, claim) => {
      assertQueueClaimHeld(claim, 'test-create');
      createdRuns += 1;
    },
  );

  const claim = claimQueueItem(item.id, 'dispatch-holder');
  assert.ok(claim);
  removeQueueItemInternal(item.id, 'reclaim-during-await');
  assert.equal(isQueueClaimHeld(claim), false);
  assert.throws(() => assertQueueClaimHeld(claim, 'after-await'), QueueClaimLostError);
  assert.equal(createdRuns, 0);
  assert.equal(releaseQueueClaim(claim), false);
});

test('assertQueueClaimHeld renews an uncontested claim past wall-clock TTL', () => {
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-claim-renew-ttl',
    },
    { kind: 'system' },
  );
  try {
    const claim = claimQueueItem(item.id, 'holder-renew', { ttlMs: 1 });
    assert.ok(claim);
    // Force past wall-clock expiry without reclaim — ownership still matches.
    const expired = new Date(Date.now() - 1_000).toISOString();
    mutateQueueItemForTests(item.id, (record) => {
      record.claimExpiresAt = expired;
    });
    claim.expiresAt = expired;
    assert.equal(isQueueClaimHeld(claim), false, 'isQueueClaimHeld still honors TTL');
    // assert renews rather than treating pure expiry as takeover.
    assert.doesNotThrow(() => assertQueueClaimHeld(claim, 'pre-create'));
    assert.equal(isQueueClaimHeld(claim), true, 'renew extends TTL');
    const renewed = getQueueSnapshot().find((record) => record.id === item.id);
    assert.ok(Date.parse(renewed!.claimExpiresAt!) > Date.now());
  } finally {
    if (getQueueSnapshot().some((q) => q.id === item.id)) {
      removeQueueItemInternal(item.id, 'test-cleanup');
    }
  }
});

test('reclaimExpiredClaims restores stranded dispatching rows to queued', () => {
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-claim-expired-strand',
    },
    { kind: 'system' },
  );
  const claim = claimQueueItem(item.id, 'holder-expire', { ttlMs: 1 });
  assert.ok(claim);
  assert.equal(getQueueSnapshot().find((record) => record.id === item.id)?.status, 'dispatching');
  // Force past expiry without waiting.
  const n = reclaimExpiredClaims(Date.parse(claim.expiresAt) + 1);
  assert.ok(n >= 1);
  assert.equal(getQueueSnapshot().find((record) => record.id === item.id)?.status, 'queued');
  assert.equal(isQueueClaimHeld(claim), false);
  // Fresh claim is possible again.
  const again = claimQueueItem(item.id, 'holder-retry');
  assert.ok(again);
  removeQueueItemInternal(item.id, 'test-cleanup');
});

test('assertQueueClaimHeld stops create after mid-callback revoke', async () => {
  // Does not rely on fleet/slot selection: claim first, then drive the
  // production createAndStartRun-shaped callback with a pause before the
  // durable-create guard (mirrors runCreate's beforeCreate hook).
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-claim-mid-callback',
      workGraphId: 'wg_mid',
      workNodeId: 'wn_mid',
    },
    { kind: 'system' },
  );
  let createdRuns = 0;
  let enteredCallback = false;
  let releaseGate: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const claim = claimQueueItem(item.id, 'mid-holder');
  assert.ok(claim);

  // Simulate createAndStartRun body: await work, then beforeCreate guard.
  const createPath = (async () => {
    enteredCallback = true;
    await gate;
    assertQueueClaimHeld(claim, 'pre-durable-createRun');
    createdRuns += 1;
  })();

  assert.equal(enteredCallback, true);
  await cancelGraphQueuedItem({
    workGraphId: 'wg_mid',
    workNodeId: 'wn_mid',
    reason: 'mid-callback-reclaim',
  });
  releaseGate!();
  await assert.rejects(() => createPath, QueueClaimLostError);
  assert.equal(createdRuns, 0);
});

test('loadQueue drops dispatching rows stamped with a terminal Run', async () => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-stamp-terminal-reconcile',
  });
  updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-stamp-terminal-reconcile',
    },
    { kind: 'system' },
  );
  const claim = claimQueueItem(item.id, 'holder-terminal');
  assert.ok(claim);
  stampQueueItemRunId(item.id, run.id);
  await persistQueueNow();

  // Simulate restart: clear in-memory queue and reload from disk.
  // loadQueue reads the same isolated test queue file.
  await loadQueue();
  assert.ok(
    !getQueueSnapshot().some((q) => q.id === item.id),
    'terminal stamped handoff must not requeue',
  );
  await cleanupRun(run.id);
});

test('reclaimExpiredClaims drops stamped rows whose Run still exists', async () => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-stamp-expire-drop',
  });
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-stamp-expire-drop',
    },
    { kind: 'system' },
  );
  const claim = claimQueueItem(item.id, 'holder-stamp-expire', { ttlMs: 1 });
  assert.ok(claim);
  await stampQueueItemRunIdNow(item.id, run.id);
  const n = reclaimExpiredClaims(Date.parse(claim.expiresAt) + 1);
  assert.ok(n >= 1);
  assert.ok(
    !getQueueSnapshot().some((q) => q.id === item.id),
    'stamped expired claim must drop, not requeue',
  );
  await cleanupRun(run.id);
});

test('loadQueue drops higher-attempt launch row when a live run owns the candidate', async () => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-attempt-mismatch',
    workGraphId: 'wg_attempt_mismatch',
    workNodeId: 'wn_attempt_mismatch',
    launchPlanId: 'plan_attempt',
    launchCandidateId: 'cand_attempt',
    launchAttempt: 1,
  });
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-attempt-mismatch',
      workGraphId: 'wg_attempt_mismatch',
      workNodeId: 'wn_attempt_mismatch',
      launchPlanId: 'plan_attempt',
      launchCandidateId: 'cand_attempt',
      launchAttempt: 2,
    },
    { kind: 'system' },
  );
  assert.equal(item.status, 'queued');
  await persistQueueNow();
  await loadQueue();
  assert.ok(
    !getQueueSnapshot().some((q) => q.id === item.id),
    'live attempt-1 owner must drop attempt-2 requeue row after crash between revive and drop',
  );
  await cleanupRun(run.id);
});

test('loadQueue keeps legacy undefined-attempt launch row against live attempt-bearing run', async () => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-legacy-attempt',
    workGraphId: 'wg_legacy_attempt',
    workNodeId: 'wn_legacy_attempt',
    launchPlanId: 'plan_legacy',
    launchCandidateId: 'cand_legacy',
    launchAttempt: 1,
  });
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-legacy-attempt',
      workGraphId: 'wg_legacy_attempt',
      workNodeId: 'wn_legacy_attempt',
      launchPlanId: 'plan_legacy',
      launchCandidateId: 'cand_legacy',
    },
    { kind: 'system' },
  );
  // Simulate legacy disk row without launchAttempt.
  mutateQueueItemForTests(item.id, (record) => {
    delete record.launchAttempt;
    record.status = 'dispatching';
  });
  await persistQueueNow();
  await loadQueue();
  const reloaded = getQueueSnapshot().find((q) => q.id === item.id);
  assert.ok(reloaded, 'undefined !== 1 must re-queue (restart attempt matrix)');
  assert.equal(reloaded.status, 'queued');
  await cleanupRun(run.id);
});

test('loadQueue drops queued rows whose handoff is already owned by a live Run', async () => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-queued-live-owner',
    workGraphId: 'wg_queued_live',
    workNodeId: 'wn_queued_live',
  });
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-queued-live-owner',
      workGraphId: 'wg_queued_live',
      workNodeId: 'wn_queued_live',
    },
    { kind: 'system' },
  );
  assert.equal(item.status, 'queued');
  await persistQueueNow();
  await loadQueue();
  assert.ok(
    !getQueueSnapshot().some((q) => q.id === item.id),
    'queued row with live owner must not survive restart',
  );
  await cleanupRun(run.id);
});

test('cancelGraphQueuedItem leaves stamped live handoffs alone', async () => {
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-cancel-stamped-live',
      workGraphId: 'wg_cancel_stamp',
      workNodeId: 'wn_cancel_stamp',
    },
    { kind: 'system' },
  );
  const claim = claimQueueItem(item.id, 'holder-stamp');
  assert.ok(claim);
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-cancel-stamped-live',
    workGraphId: 'wg_cancel_stamp',
    workNodeId: 'wn_cancel_stamp',
  });
  stampQueueItemRunId(item.id, run.id);
  const cancelled = await cancelGraphQueuedItem({
    workGraphId: 'wg_cancel_stamp',
    workNodeId: 'wn_cancel_stamp',
    reason: 'should-skip-stamped-live',
  });
  assert.equal(cancelled, false);
  assert.ok(
    getQueueSnapshot().some((q) => q.id === item.id),
    'stamped live row remains',
  );
  await removeQueueItemInternalNow(item.id, 'test-cleanup');
  await cleanupRun(run.id);
});

test('partial create after durable stamp drops the row instead of requeueing', async (t) => {
  setCachedFleetForTests(readyFleetSlot('partial-slot') as any);
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-partial-create-drop',
      allowedSlots: ['partial-slot'],
      autoDispatch: false,
    },
    { kind: 'system' },
  );
  let partialRunId: string | undefined;
  initDispatchQueue(
    () => {},
    async (queued, claim) => {
      assertQueueClaimHeld(claim, 'partial-create');
      const run = createRun({
        flowType: 'fix-bug',
        project: 'farmslot-farm',
        ticketOrPr: 'PROJ-partial-create-drop',
      });
      partialRunId = run.id;
      await stampQueueItemRunIdNow(queued.id, run.id);
      await persistRunNow(run, 'test-durable-before-fail');
      throw new Error('simulated post-stamp failure');
    },
  );
  t.after(async () => {
    if (partialRunId && getRun(partialRunId)) await cleanupRun(partialRunId);
  });
  await tryDispatchNext();
  assert.ok(partialRunId, 'callback must create a Run before failing');
  assert.ok(getRun(partialRunId));
  assert.ok(
    !getQueueSnapshot().some((q) => q.id === item.id),
    'durable partial create must drop the queue row, not requeue',
  );
});

test('memory-only create failure requeues and purges the orphan Run', async (t) => {
  setCachedFleetForTests(readyFleetSlot('memory-only-slot') as any);
  const item = addItem(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: 'PROJ-memory-only-create',
      allowedSlots: ['memory-only-slot'],
      autoDispatch: false,
    },
    { kind: 'system' },
  );
  let orphanId: string | undefined;
  initDispatchQueue(
    () => {},
    async (queued, claim) => {
      assertQueueClaimHeld(claim, 'memory-only-create');
      // Defer disk write so the catch path sees a memory-only orphan.
      const run = createRun(
        {
          flowType: 'fix-bug',
          project: 'farmslot-farm',
          ticketOrPr: 'PROJ-memory-only-create',
        },
        { deferBackgroundPersist: true },
      );
      orphanId = run.id;
      await stampQueueItemRunIdNow(queued.id, run.id);
      throw new Error('simulated persist failure before run file');
    },
  );
  t.after(async () => {
    if (orphanId && getRun(orphanId)) await cleanupRun(orphanId);
  });
  await tryDispatchNext();
  assert.ok(orphanId);
  assert.equal(getRun(orphanId), undefined, 'memory-only orphan must be purged');
  const requeued = getQueueSnapshot().find((q) => q.id === item.id);
  assert.ok(requeued, 'row must be requeued for retry');
  assert.equal(requeued.status, 'queued');
  assert.equal(requeued.runId, undefined);
});
