import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext, Run } from '@farmslot/protocol';

import { runActivityStepStatus, runActivityView } from '../src/run-activity.js';

const actor = (
  role: AgentContext['role'],
  overrides: Partial<AgentContext> = {},
): AgentContext => ({
  id: role,
  role,
  label: role,
  status: 'working',
  runId: 'r1',
  slotId: 's1',
  updatedAt: '2026-10-21T01:04:00.000Z',
  startedAt: '2026-10-19T19:19:44.000Z',
  attemptStartedAt: '2026-10-21T01:03:52.000Z',
  ...overrides,
});

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'r1',
    familyId: 'f1',
    lane: 'production',
    flowType: 'dev',
    status: 'fixing',
    project: 'fixture',
    ticketOrPr: 'FIXTURE-1',
    slotId: 's1',
    branch: 'fix/fixture',
    taskFile: null,
    createdAt: '2026-10-19T12:00:00.000Z',
    updatedAt: '2026-10-21T01:04:00.000Z',
    statusChangedAt: '2026-10-21T01:03:40.000Z',
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-6.1-sol' },
    decisions: [],
    steps: [
      { name: 'review', status: 'done' },
      { name: 'complete', status: 'done' },
      {
        name: 'human-gate',
        status: 'running',
        detail: 'Reviewer found 2 issue(s); worker applying fixes (1/3)...',
      },
    ],
    reviewRoundAdmissions: Array.from({ length: 10 }, (_, i) => `admission-${i}`),
    agentContexts: [actor('review-fix')],
    ...overrides,
  };
}

test('the reused fix actor has one current node, a fresh elapsed-time origin and the next review round', () => {
  const source = run({ status: 'reviewing' });
  const view = runActivityView(source)!;
  assert.equal(view.label, 'Worker fixing 2 review findings · round 11');
  assert.equal(view.nodeId, 'post-gate-publication-review-fix');
  assert.equal(view.startedAt, '2026-10-21T01:03:52.000Z');
  assert.deepEqual(
    view.steps.filter((step) => step.status === 'running'),
    [view.step],
  );
  assert.equal(source.steps[2].status, 'running');
});

test('a live reviewer takes the current node while old fix contexts and step copy remain', () => {
  const view = runActivityView(
    run({
      status: 'fixing',
      agentContexts: [
        actor('review-fix'),
        actor('review', { attemptStartedAt: '2026-10-21T01:10:00.000Z' }),
      ],
    }),
  )!;
  assert.equal(view.label, 'Reviewer checking changes · round 10');
  assert.equal(view.nodeId, 'post-gate-publication-review-active');
  assert.equal(view.startedAt, '2026-10-21T01:10:00.000Z');
  assert.equal(view.steps.filter((step) => step.status === 'running').length, 1);
});

test('activity rounds use the same maintenance ownership and settlements as the gate budget', () => {
  const source = run({
    flowType: 'update-branch',
    status: 'reviewing',
    agentContexts: [actor('review')],
    reviewRoundAdmissions: ['p1', 'p2', 'p3', 'p4', 'p5', 'own', 'sibling', 'refunded', 'own'],
    reviewRoundOwners: { own: 'r1', sibling: 'other', refunded: 'r1' },
    reviewRoundSettlements: { refunded: { reason: 'timeout', at: '2026-10-24T00:00:00Z' } },
  });
  assert.equal(runActivityView(source)?.label, 'Reviewer checking changes · round 1');
  assert.equal(
    runActivityView({ ...source, agentContexts: [actor('review-fix')] })?.label,
    'Worker fixing 2 review findings · round 2',
  );
  assert.equal(
    runActivityView({ ...source, flowType: 'dev' })?.label,
    'Reviewer checking changes · round 5',
  );
  source.reviewRoundSettlements = {};
  assert.equal(runActivityView(source)?.label, 'Reviewer checking changes · round 2');
});

test('activity uses a legacy gate count only when durable admission metadata is absent', () => {
  const source = run({
    status: 'reviewing',
    agentContexts: [actor('review')],
    decisions: [
      {
        id: 'old',
        type: 'engine_human_gate',
        title: 'Ready',
        description: '',
        actions: [],
        createdAt: '2026-10-24T00:00:00Z',
        payload: {
          kind: 'ready',
          prNumber: 42,
          repo: null,
          branch: 'feature',
          workerReport: '',
          diffStat: { files: 0, additions: 0, deletions: 0 },
          reviewRoundBudget: {
            used: 5,
            limit: 5,
            remaining: 0,
            label: 'Review rounds 5/5',
            noVerdict: 0,
            noVerdictLimit: 3,
          },
        },
      },
    ],
  });
  source.reviewRoundAdmissions = undefined;
  assert.equal(runActivityView(source)?.label, 'Reviewer checking changes · round 5');
  source.reviewRoundAdmissions = ['one', 'refunded'];
  source.reviewRoundSettlements = { refunded: { reason: 'timeout', at: '2026-10-24T00:00:00Z' } };
  assert.equal(runActivityView(source)?.label, 'Reviewer checking changes · round 1');
});

test('a person waiting at a gate, a paused run and a finished run have no running actor', () => {
  for (const status of ['blocked', 'paused', 'done'] as const)
    assert.equal(runActivityView(run({ status })), null);
  assert.equal(
    runActivityView(
      run({
        waitingForOperator: {
          who: 'operator',
          reason: 'Check evidence',
          contextId: 'review-fix',
          attemptId: 'attempt-1',
          since: '2026-10-21T01:04:00.000Z',
        },
      }),
    ),
    null,
  );
});

test('a blocked open gate has the same waiting state in both clients despite a retained working actor', () => {
  const source = run({
    status: 'blocked',
    decisions: [
      {
        id: 'gate-1',
        type: 'engine_human_gate',
        title: 'Publish',
        description: 'Waiting for a publish decision',
        actions: [],
        createdAt: '2026-10-21T01:30:00.000Z',
      },
    ],
  });
  assert.equal(runActivityView(source), null);
  assert.equal(runActivityStepStatus(source, source.steps[2]), 'blocked');
});

test('a non-publication flow keeps its actual review step as the current activity', () => {
  const source = run({
    flowType: 'update-branch',
    status: 'reviewing',
    steps: [{ name: 'review', status: 'running', startedAt: '2026-10-21T01:03:52.000Z' }],
    agentContexts: [actor('review')],
  });
  const view = runActivityView(source)!;
  assert.equal(view.nodeId, 'review');
  assert.equal(view.phase, undefined);
  assert.equal(view.steps.length, 1);
  assert.equal(view.steps[0].status, 'running');
});
