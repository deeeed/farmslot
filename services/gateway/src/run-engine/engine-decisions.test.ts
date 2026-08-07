import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReadyGatePayload, ReviewGatePayload, Run, RunDecision } from '@farmslot/protocol';

import {
  applyRepeatReviewSelection,
  autoResolveEngineDecision,
  buildCollisionSuccessorParams,
  buildRepeatReviewContext,
  collisionAutoResolveAction,
  collisionDecisionActions,
  findLatestPriorReviewRun,
  repeatReviewDecisionActions,
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
    repeatReviewContext: overrides.repeatReviewContext,
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
    completedAt: overrides.completedAt,
  };
}

function reviewDecision(overrides: Partial<ReviewGatePayload> = {}): RunDecision {
  return {
    id: 'review-gate',
    type: 'engine_review_posting',
    title: 'review',
    description: '',
    actions: [],
    createdAt: '2026-08-06T10:00:00.000Z',
    payload: {
      kind: 'review',
      prNumber: 42,
      repo: 'Owner/Repo',
      recommendation: 'request changes',
      reviewMd: 'review.md',
      lineComments: [{ path: 'src/a.ts', line: 7, body: 'Fix this.', severity: 'blocking' }],
      reviewSnapshot: {
        source: 'github-pr',
        capturedAt: '2026-08-06T09:59:00.000Z',
        headSha: 'aaaaaaaaaaaaaaaa',
      },
      artifactManifest: [{ path: 'artifacts/review.md', purpose: 'review' }],
      ...overrides,
    },
  };
}

function readyDecision(): RunDecision {
  const payload: ReadyGatePayload = {
    kind: 'ready',
    prNumber: 41,
    repo: 'Owner/Repo',
    diffStat: { files: 1, additions: 2, deletions: 0 },
    workerReport: 'done',
    branch: 'feature',
    artifactManifest: [{ path: 'artifacts/recipe.json', purpose: 'recipe proof' }],
  };
  return {
    id: 'ready-gate',
    type: 'engine_human_gate',
    title: 'ready',
    description: '',
    actions: [],
    createdAt: '2026-08-06T08:00:00.000Z',
    payload,
  };
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

test('findLatestPriorReviewRun matches canonical PR identity and completion order', () => {
  const current = makeRun({
    id: 'current',
    project: 'farm-a',
    flowType: 'review-pr',
    ticketOrPr: 'Owner/Repo#42',
  });
  const older = makeRun({
    id: 'older',
    project: 'farm-a',
    flowType: 'review-pr',
    ticketOrPr: 'owner/repo#42',
    status: 'done',
    completedAt: '2026-08-06T10:00:00.000Z',
  });
  const latest = makeRun({
    id: 'latest',
    project: 'farm-a',
    flowType: 'review-pr',
    ticketOrPr: 'OWNER/REPO#42',
    status: 'done',
    completedAt: '2026-08-06T11:00:00.000Z',
  });
  const wrongProject = makeRun({
    id: 'wrong-project',
    project: 'farm-b',
    flowType: 'review-pr',
    ticketOrPr: 'owner/repo#42',
    status: 'done',
    completedAt: '2026-08-06T12:00:00.000Z',
  });
  const newerWithoutVerdict = makeRun({
    id: 'newer-without-verdict',
    project: 'farm-a',
    flowType: 'review-pr',
    ticketOrPr: 'owner/repo#42',
    status: 'done',
    completedAt: '2026-08-06T13:00:00.000Z',
  });
  older.decisions = [reviewDecision()];
  latest.decisions = [reviewDecision()];
  wrongProject.decisions = [reviewDecision()];

  assert.equal(
    findLatestPriorReviewRun(current, [older, wrongProject, latest, newerWithoutVerdict])?.id,
    'latest',
  );
});

test('buildRepeatReviewContext freezes prior findings, review range, and Farmslot evidence', () => {
  const prior = makeRun({
    id: 'prior-review',
    familyId: 'family-1',
    project: 'farm-a',
    flowType: 'review-pr',
    ticketOrPr: 'owner/repo#42',
    status: 'done',
    decisions: [reviewDecision()],
  });
  const origin = makeRun({
    id: 'origin-run',
    familyId: 'family-1',
    project: 'farm-a',
    flowType: 'fix-bug',
    decisions: [readyDecision()],
  });

  const context = buildRepeatReviewContext(
    makeRun({
      id: 'current',
      project: 'farm-a',
      flowType: 'review-pr',
      ticketOrPr: 'owner/repo#42',
    }),
    prior,
    {
      project: 'farm-a',
      repository: 'owner/repo',
      prNumber: 42,
      headSha: 'bbbbbbbbbbbbbbbb',
      baseRef: 'main',
    },
    [prior, origin],
  );

  assert.equal(context.reviewScope, 'incremental');
  assert.equal(context.validationDepth, 'static-code');
  assert.equal(context.sessionIntent, 'resume');
  assert.deepEqual(
    context.priorGenerations?.map((entry) => entry.generation),
    [1],
  );
  assert.equal(context.priorReviewedHeadSha, 'aaaaaaaaaaaaaaaa');
  assert.equal(context.currentHeadSha, 'bbbbbbbbbbbbbbbb');
  assert.deepEqual(context.unresolvedFindings, [
    { file: 'src/a.ts', line: 7, description: 'Fix this.' },
  ]);
  assert.equal(context.originatingRunId, 'origin-run');
  assert.deepEqual(context.farmslotEvidenceRefs, [
    { path: 'artifacts/recipe.json', purpose: 'recipe proof' },
  ]);
  assert.equal(repeatReviewDecisionActions(context)[0]?.id, 'reuse-incremental-static');
  assert.equal(
    repeatReviewDecisionActions(context).some((action) => action.id === 'fresh-full-live'),
    false,
  );
});

test('missing prior reviewed head disables only incremental continuation', () => {
  const prior = makeRun({
    id: 'prior-review',
    project: 'farm-a',
    flowType: 'review-pr',
    ticketOrPr: 'owner/repo#42',
    status: 'done',
    decisions: [reviewDecision({ reviewSnapshot: undefined })],
  });
  const context = buildRepeatReviewContext(
    makeRun({ project: 'farm-a', flowType: 'review-pr', ticketOrPr: 'owner/repo#42' }),
    prior,
    {
      project: 'farm-a',
      repository: 'owner/repo',
      prNumber: 42,
      headSha: 'bbbbbbbbbbbbbbbb',
    },
    [prior],
  );

  assert.equal(context.reviewScope, 'full');
  assert.equal(context.sessionIntent, 'reset');
  assert.match(context.incrementalUnavailableReason ?? '', /head SHA/);
  assert.deepEqual(
    repeatReviewDecisionActions(context).map((action) => action.id),
    ['reuse-full-static', 'fresh-full-static', 'fresh-full-live'],
  );
});

test('full repeat-review selections always reset reviewer reasoning', () => {
  const prior = makeRun({
    id: 'prior-review',
    project: 'farm-a',
    flowType: 'review-pr',
    ticketOrPr: 'owner/repo#42',
    status: 'done',
    decisions: [reviewDecision()],
  });
  const context = buildRepeatReviewContext(
    makeRun({ project: 'farm-a', flowType: 'review-pr', ticketOrPr: 'owner/repo#42' }),
    prior,
    {
      project: 'farm-a',
      repository: 'owner/repo',
      prNumber: 42,
      headSha: 'bbbbbbbbbbbbbbbb',
    },
    [prior],
  );

  assert.equal(
    applyRepeatReviewSelection(context, 'reuse-incremental-static').sessionIntent,
    'resume',
  );
  assert.equal(applyRepeatReviewSelection(context, 'reuse-full-static').sessionIntent, 'reset');
  assert.equal(applyRepeatReviewSelection(context, 'fresh-full-static').sessionIntent, 'reset');
  assert.equal(applyRepeatReviewSelection(context, 'fresh-full-live').sessionIntent, 'reset');
});

test('repeat-review context accumulates the complete predecessor chain', () => {
  const first = makeRun({
    id: 'review-1',
    familyId: 'family-1',
    project: 'farm-a',
    flowType: 'review-pr',
    ticketOrPr: 'owner/repo#42',
    status: 'done',
    decisions: [reviewDecision()],
  });
  const secondContext = buildRepeatReviewContext(
    makeRun({ id: 'review-2', project: 'farm-a', flowType: 'review-pr' }),
    first,
    {
      project: 'farm-a',
      repository: 'owner/repo',
      prNumber: 42,
      headSha: 'bbbbbbbbbbbbbbbb',
    },
    [first],
  );
  const second = makeRun({
    id: 'review-2',
    familyId: 'family-1',
    project: 'farm-a',
    flowType: 'review-pr',
    ticketOrPr: 'owner/repo#42',
    status: 'done',
    decisions: [
      reviewDecision({
        reviewSnapshot: {
          source: 'github-pr',
          capturedAt: '2026-08-06T10:59:00.000Z',
          headSha: 'bbbbbbbbbbbbbbbb',
        },
      }),
    ],
    repeatReviewContext: secondContext,
  });

  const thirdContext = buildRepeatReviewContext(
    makeRun({ id: 'review-3', project: 'farm-a', flowType: 'review-pr' }),
    second,
    {
      project: 'farm-a',
      repository: 'owner/repo',
      prNumber: 42,
      headSha: 'cccccccccccccccc',
    },
    [first, second],
  );

  assert.equal(thirdContext.generation, 3);
  assert.deepEqual(
    thirdContext.priorGenerations?.map((entry) => entry.generation),
    [1, 2],
  );
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
