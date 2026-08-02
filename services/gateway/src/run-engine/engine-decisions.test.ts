import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  autoResolveEngineDecision,
  buildCollisionSuccessorParams,
  collisionAutoResolveAction,
  collisionDecisionActions,
} from './engine-decisions.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? 'run-1',
    familyId: overrides.familyId ?? 'family-1',
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? 'PROJ-1',
    lane: overrides.lane ?? 'production',
    variant: overrides.variant ?? null,
    flowType: overrides.flowType ?? 'dev',
    mode: overrides.mode ?? 'interactive',
    status: overrides.status ?? 'created',
    project: overrides.project ?? 'demo',
    ticketOrPr: overrides.ticketOrPr ?? 'PROJ-1',
    slotId: overrides.slotId ?? null,
    branch: overrides.branch ?? null,
    taskFile: overrides.taskFile ?? null,
    steps: overrides.steps ?? [],
    decisions: overrides.decisions ?? [],
    engineState: overrides.engineState,
    backlogItemId: overrides.backlogItemId,
    workGraphId: overrides.workGraphId,
    workNodeId: overrides.workNodeId,
    allowedSlots: overrides.allowedSlots,
    metrics: overrides.metrics ?? {
      nudgeCount: 0,
      runner: 'claude',
      model: 'opus',
      runnerSessionId: null,
      runnerSessionPath: null,
      outcome: 'success',
    },
    createdAt: overrides.createdAt ?? '2026-05-04T10:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-04T10:00:00.000Z',
  } as Run;
}

test('collision successor retains backlog and work-graph ownership', () => {
  const params = buildCollisionSuccessorParams(
    makeRun({
      backlogItemId: 'backlog-1',
      workGraphId: 'graph-1',
      workNodeId: 'node-1',
      allowedSlots: ['slot-1'],
    }),
    'family-2',
    'collision-120000',
  );

  assert.equal(params.backlogItemId, 'backlog-1');
  assert.equal(params.workGraphId, 'graph-1');
  assert.equal(params.workNodeId, 'node-1');
  assert.deepEqual(params.allowedSlots, ['slot-1']);
});

test('collisionAutoResolveAction auto-resolves comparison skipPrepare retries', () => {
  assert.equal(
    collisionAutoResolveAction(
      makeRun({
        lane: 'comparison',
        mode: 'interactive',
        engineState: { flags: { skipPrepare: true } },
      }),
    ),
    'create-new',
  );
});

test('collisionAutoResolveAction auto-resolves interactive comparison-lane collisions', () => {
  assert.equal(
    collisionAutoResolveAction(makeRun({ lane: 'comparison', mode: 'interactive' })),
    'create-new',
  );
});

test('collisionDecisionActions omits start-comparison when run is already comparison-lane', () => {
  const ids = collisionDecisionActions({ lane: 'comparison' }).map((a) => a.id);
  assert.deepEqual(ids, ['create-new', 'abort']);
});

test('collisionDecisionActions offers start-comparison for production-lane collisions', () => {
  const ids = collisionDecisionActions({ lane: 'production' }).map((a) => a.id);
  assert.deepEqual(ids, ['create-new', 'start-comparison', 'abort']);
});

test('collisionDecisionActions start-comparison is not replayable on comparison-lane reruns', () => {
  const comparisonActions = collisionDecisionActions({ lane: 'comparison' });
  const resolved = 'start-comparison';
  const stillOffered = comparisonActions.some((action) => action.id === resolved);
  assert.equal(stillOffered, false);
});

test('collisionAutoResolveAction auto-resolves autonomous runs', () => {
  assert.equal(collisionAutoResolveAction(makeRun({ mode: 'autonomous' })), 'create-new');
});

test('collisionAutoResolveAction leaves interactive production collisions unresolved', () => {
  assert.equal(
    collisionAutoResolveAction(makeRun({ lane: 'production', mode: 'interactive' })),
    null,
  );
});

test('autoResolveEngineDecision never auto-resolves human gates', () => {
  const actions = [
    { id: 'approve-publish', label: 'Approve Publish', style: 'primary' as const },
    { id: 'ready', label: 'Mark Ready', style: 'primary' as const },
    { id: 'hold', label: 'Hold', style: 'secondary' as const },
  ];

  assert.equal(
    autoResolveEngineDecision(
      makeRun({ mode: 'autonomous', flowType: 'dev' }),
      'human_gate',
      actions,
    ),
    null,
  );
  assert.equal(
    autoResolveEngineDecision(
      makeRun({ mode: 'validation', flowType: 'fix-bug' }),
      'human_gate',
      actions,
    ),
    null,
  );
});

test('autoResolveEngineDecision never auto-dismisses review publication', () => {
  const actions = [
    { id: 'post', label: 'Post to PR', style: 'primary' as const },
    { id: 'dismiss', label: 'Dismiss', style: 'secondary' as const },
  ];

  assert.equal(
    autoResolveEngineDecision(
      makeRun({ mode: 'autonomous', flowType: 'review-pr' }),
      'review_posting',
      actions,
    ),
    null,
  );
  assert.equal(
    autoResolveEngineDecision(
      makeRun({ mode: 'validation', flowType: 'review-pr' }),
      'review_posting',
      actions,
    ),
    null,
  );
});
