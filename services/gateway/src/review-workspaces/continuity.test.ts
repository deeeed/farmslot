import assert from 'node:assert/strict';
import test from 'node:test';

import type { RepeatReviewContext, Run } from '@farmslot/protocol';

import { assertPrimaryReviewContext } from '../run-engine/review-plan.js';

import { configureWorkspaceContinuity } from './continuity.js';

const prior = {
  id: 'prior',
  project: 'farm',
  ticketOrPr: 'example/app#42',
  status: 'done',
  transport: 'tmux',
  createdByPrincipalId: 'owner',
  nativeOwnerPrincipalId: 'owner',
  reviewWorkspace: { machine: 'machine' },
  agentContexts: [
    {
      id: 'review',
      role: 'review',
      status: 'complete',
      runner: 'cursor',
      model: 'model',
      runnerSessionId: 'chat',
      reviewId: 'lineage',
    },
  ],
} as Run;
const current = {
  project: 'farm',
  ticketOrPr: 'example/app#42',
  reviewMode: 'warm',
  transport: 'tmux',
  createdByPrincipalId: 'owner',
  nativeOwnerPrincipalId: 'owner',
  reviewWorkspaceTarget: { machine: 'machine' },
  metrics: { runner: 'cursor', model: 'model' },
} as Run;
const context = () =>
  ({
    repository: 'example/app',
    prNumber: 42,
    priorReviewedHeadSha: 'a'.repeat(40),
    session: { reviewId: 'lineage' },
  }) as RepeatReviewContext;

test('verified WARM workspace continuity retains exact PR lineage, session and last head', () => {
  const result = context();
  configureWorkspaceContinuity(current, prior, result);
  assert.equal(result.mode, 'warm');
  assert.deepEqual(result.session, {
    mode: 'warm',
    continuity: 'resumed',
    reviewId: 'lineage',
    repository: 'example/app',
    prNumber: 42,
    lastReviewedHeadSha: 'a'.repeat(40),
    priorRunId: 'prior',
    priorSessionId: 'chat',
    sessionId: 'chat',
  });
});

test('unavailable WARM refuses instead of changing mode', () => {
  for (const other of [
    { ...prior, nativeOwnerPrincipalId: 'other' },
    { ...prior, project: 'other' },
    { ...prior, status: 'monitoring' },
    { ...prior, ticketOrPr: 'example/foreign#42' },
    { ...prior, agentContexts: [] },
    { ...prior, agentContexts: [{ ...prior.agentContexts![0], reviewId: 'foreign' }] },
    { ...prior, agentContexts: [{ ...prior.agentContexts![0], model: 'other' }] },
  ]) {
    const result = context();
    assert.throws(
      () => configureWorkspaceContinuity(current, other as Run, result),
      /WARM review unavailable/,
    );
    assert.equal(result.mode, 'warm');
  }
  assert.throws(
    () =>
      configureWorkspaceContinuity(current, prior, {
        ...context(),
        warmUnavailableReason: 'Rebased head',
      }),
    /Rebased head/,
  );
});

test('COLD records fresh continuity without a retained lineage', () => {
  const result = context();
  configureWorkspaceContinuity({ ...current, reviewMode: 'cold' }, prior, result);
  assert.deepEqual(result.session, { mode: 'cold', continuity: 'fresh', priorRunId: 'prior' });
});

test('planner and workspace continuity both honor the explicit run mode over PR defaults', () => {
  for (const mode of ['warm', 'cold'] as const) {
    const run = {
      ...current,
      flowType: 'review-pr',
      reviewMode: mode,
      prWork: { review: { options: { mode: mode === 'warm' ? 'cold' : 'warm' } } },
    } as Run;
    const result = context();
    if (mode === 'warm')
      assert.throws(() => assertPrimaryReviewContext(run), /explicit reviewId lineage/);
    else assert.doesNotThrow(() => assertPrimaryReviewContext(run));
    configureWorkspaceContinuity(run, prior, result);
    assert.equal(result.mode, mode);
    assert.equal(result.session?.continuity, mode === 'warm' ? 'resumed' : 'fresh');
  }
});

test('nested WARM selection without a retained session cannot fall back to COLD', () => {
  const run = {
    ...current,
    reviewMode: undefined,
    prWork: { review: { options: { mode: 'warm' } } },
  } as Run;
  assert.throws(
    () => configureWorkspaceContinuity(run, { ...prior, agentContexts: [] }, context()),
    /WARM review unavailable/,
  );
});
