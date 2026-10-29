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
    currentHeadSha: 'b'.repeat(40),
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

test('nested WARM selection without an owned review lineage is refused', () => {
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

test('workspace continuity binds the creator generation in both directions', () => {
  for (const [priorGeneration, currentGeneration] of [
    [undefined, 1],
    [1, undefined],
  ]) {
    assert.throws(
      () =>
        configureWorkspaceContinuity(
          { ...current, createdByPrincipalGeneration: currentGeneration },
          { ...prior, createdByPrincipalGeneration: priorGeneration },
          context(),
        ),
      /WARM review unavailable/,
    );
  }
  const result = context();
  configureWorkspaceContinuity(
    { ...current, createdByPrincipalGeneration: 1 },
    { ...prior, createdByPrincipalGeneration: 1 },
    result,
  );
  assert.equal(result.session?.continuity, 'resumed');
  assert.equal(result.session?.sessionId, 'chat');
});

test('an unavailable workspace session keeps its lineage and findings in a fresh delta fallback', () => {
  for (const variant of [
    { ...current, reviewWorkspaceTarget: { machine: 'elsewhere' } },
    { ...current, transport: 'native' as const },
    { ...current, metrics: { ...current.metrics, model: 'other' } },
  ]) {
    const result = {
      ...context(),
      currentHeadSha: 'b'.repeat(40),
      unresolvedFindings: [{ file: 'source.ts', description: 'Earlier issue' }],
    };
    configureWorkspaceContinuity(variant, prior, result);
    assert.equal(result.mode, 'cold');
    assert.equal(result.session?.continuity, 'fresh');
    assert.equal(
      result.session?.fallback?.reason,
      variant.transport === 'native'
        ? 'unsupported-runner'
        : variant.metrics.model === 'other'
          ? 'model-mismatch'
          : 'slot-mismatch',
    );
    assert.equal(result.session?.reviewId, 'lineage');
    assert.equal(result.session?.priorRunId, prior.id);
    assert.deepEqual(result.session?.fallback?.comparedRanges, [
      `${'a'.repeat(40)}..${'b'.repeat(40)}`,
    ]);
    assert.deepEqual(result.unresolvedFindings, [
      { file: 'source.ts', description: 'Earlier issue' },
    ]);
  }
});

test('a missing runnerSessionId names the missing field and starts a fresh delta', () => {
  const result = context();
  configureWorkspaceContinuity(
    current,
    { ...prior, agentContexts: [{ ...prior.agentContexts![0], runnerSessionId: undefined }] },
    result,
  );
  assert.equal(result.session?.fallback?.reason, 'missing-session');
  assert.match(result.session?.fallback?.detail ?? '', /runnerSessionId/);
  assert.equal(result.session?.reviewId, 'lineage');
});

test('another active reviewer holding the session receives no resumed prompt', () => {
  const result = context();
  configureWorkspaceContinuity(current, prior, result, [
    { ...prior, id: 'holder', agentContexts: [{ ...prior.agentContexts![0], status: 'working' }] },
  ]);
  assert.equal(result.session?.fallback?.reason, 'session-busy');
  assert.equal(result.session?.continuity, 'fresh');
  assert.equal(result.session?.sessionId, undefined);
});

test('Cursor resumes its retained chat after cleanup of the previous checkout', () => {
  const result = context();
  configureWorkspaceContinuity(
    current,
    { ...prior, reviewWorkspace: { ...prior.reviewWorkspace!, cleanedAt: '2026-10-29T21:00:00Z' } },
    result,
  );
  assert.equal(result.session?.continuity, 'resumed');
  assert.equal(result.session?.fallback, undefined);
  assert.equal(result.session?.reviewId, 'lineage');
});

test('a runner without workspace-session resume uses a recorded fresh delta', () => {
  const result = context();
  configureWorkspaceContinuity(
    { ...current, metrics: { runner: 'codex', model: 'model' } },
    { ...prior, agentContexts: [{ ...prior.agentContexts![0], runner: 'codex' }] },
    result,
  );
  assert.equal(result.session?.continuity, 'fresh');
  assert.equal(result.session?.fallback?.reason, 'unsupported-runner');
  assert.equal(result.session?.sessionId, undefined);
});
