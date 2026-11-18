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

test('an omitted Claude effort keeps the recorded workspace reviewer', () => {
  const claudePrior = {
    ...prior,
    agentContexts: [
      { ...prior.agentContexts![0], runner: 'claude', model: 'opus', effort: 'medium' },
    ],
  } as Run;
  const claudeCurrent = {
    ...current,
    metrics: { runner: 'claude', model: 'opus' },
  } as Run;
  const result = context();
  configureWorkspaceContinuity(claudeCurrent, claudePrior, result);
  assert.equal(result.session?.continuity, 'resumed');
  assert.throws(
    () => configureWorkspaceContinuity({ ...claudeCurrent, effort: 'low' }, claudePrior, context()),
    /WARM review unavailable/,
  );
});

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
    {
      ...prior,
      status: 'blocked',
      reviewWorkspace: {
        ...prior.reviewWorkspace!,
        retainedAt: '2026-11-18T00:00:00Z',
        executionStoppedAt: '2026-11-18T00:00:01Z',
      },
    },
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
        priorReviewedHeadSha: undefined,
      }),
    /missing prior reviewed head/,
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

test('the Codex workspace capability permits a verified retained conversation', () => {
  const source = {
    ...prior,
    agentContexts: prior.agentContexts!.map((c) => ({
      ...c,
      runner: 'codex',
      runnerSessionPath: '/owned/previous/rollout.jsonl',
    })),
  };
  const next = { ...current, metrics: { runner: 'codex', model: 'model' } };
  const result = context();
  configureWorkspaceContinuity(next, source, result);
  assert.equal(result.session?.priorSessionId, 'chat');
  assert.equal(result.session?.continuity, 'resumed');
});

test('only expiry permits an explicit COLD fallback and preserves the prior lineage', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T01:00:00Z') });
  const source = {
    ...prior,
    completedAt: '2026-11-01T00:00:00Z',
    reviewWorkspace: { ...prior.reviewWorkspace!, retentionDays: 2 },
  };
  const result = context();
  result.currentHeadSha = 'b'.repeat(40);
  const subject = {
    repository: 'example/app',
    repositoryUrl: 'https://example.invalid/app.git',
    baseSha: 'c'.repeat(40),
    headSha: result.currentHeadSha,
    branch: 'feature',
    title: 'Fixture',
    body: '',
    capturedAt: '2026-11-06T01:00:00Z',
  };
  configureWorkspaceContinuity(current, source, result, subject);
  assert.equal(result.mode, 'cold');
  assert.equal(result.session?.reviewId, 'lineage');
  assert.match(result.session?.fallback?.detail ?? '', /expired/);
  assert.deepEqual(result.session?.fallback?.comparedRanges, [
    `${subject.baseSha}...${subject.headSha}`,
  ]);
  const live = context();
  configureWorkspaceContinuity(
    current,
    { ...source, completedAt: '2026-11-05T00:00:00Z' },
    live,
    subject,
  );
  assert.equal(live.mode, 'warm');
});

test('explicit cold after expiry may use another authorized machine while preserving the expiry reason', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T00:00:00Z') });
  const result = context();
  const source = {
    ...prior,
    reviewWorkspace: { ...prior.reviewWorkspace!, retainedUntil: '2026-11-03T00:00:00Z' },
  };
  configureWorkspaceContinuity(
    {
      ...current,
      reviewMode: 'cold',
      reviewContext: {
        reviewLineages: [{ reviewId: 'lineage', repository: 'example/app', prNumber: 42 }],
      },
      reviewWorkspaceTarget: { machine: 'other-machine' },
    },
    source,
    result,
  );
  assert.equal(result.mode, 'cold');
  assert.match(result.session?.fallback?.detail ?? '', /expired/);
});

test('every resumable terminal adapter preserves the exact retained conversation', () => {
  for (const runner of ['claude', 'codex', 'pi', 'cursor', 'grok']) {
    const source = { ...prior, agentContexts: prior.agentContexts!.map((c) => ({ ...c, runner })) };
    const result = context();
    configureWorkspaceContinuity(
      { ...current, metrics: { runner, model: 'model' } },
      source,
      result,
    );
    assert.equal(result.session?.sessionId, 'chat');
    assert.equal(result.session?.continuity, 'resumed');
  }
});

test('an unsupported adapter keeps the delta and prior findings in a fresh session', () => {
  const source = {
    ...prior,
    agentContexts: prior.agentContexts!.map((c) => ({ ...c, runner: 'opencode' })),
  };
  const run = { ...current, metrics: { runner: 'opencode', model: 'model' } };
  const result = {
    ...context(),
    currentHeadSha: 'b'.repeat(40),
    unresolvedFindings: [{ file: 'src/file.ts', line: 1, description: 'Earlier finding' }],
  };
  configureWorkspaceContinuity(run, source, result);
  assert.equal(result.mode, 'cold');
  assert.equal(result.session?.continuity, 'fresh');
  assert.equal(result.session?.reviewId, 'lineage');
  assert.equal(result.session?.sessionId, undefined);
  assert.equal(result.session?.fallback?.reason, 'session-resume-unsupported');
  assert.deepEqual(result.session?.fallback?.comparedRanges, [
    `${'a'.repeat(40)}..${'b'.repeat(40)}`,
  ]);
  assert.equal(result.unresolvedFindings[0].description, 'Earlier finding');
  assert.throws(
    () =>
      configureWorkspaceContinuity(run, { ...source, createdByPrincipalId: 'foreign' }, context()),
    /WARM review unavailable/,
  );
});

test('a stopped transferred attempt without a verdict keeps WARM and its validated delta baseline', () => {
  const source = {
    ...prior,
    reviewWorkspace: {
      ...prior.reviewWorkspace!,
      workspaceId: 'source',
      transferredTo: { runId: 'interrupted', generation: 1 },
    },
  };
  const interrupted: Run = {
    ...prior,
    id: 'interrupted',
    status: 'cancelled',
    metrics: { ...current.metrics },
    reviewResult: undefined,
    reviewWorkspace: {
      ...source.reviewWorkspace,
      transferredTo: undefined,
      executionStoppedAt: '2026-11-12T00:00:00Z',
      continuedFrom: {
        runId: prior.id,
        headSha: 'a'.repeat(40),
        baseSha: '0'.repeat(40),
        taskPath: '/prior/task',
      },
    },
    repeatReviewContext: {
      ...context(),
      session: { mode: 'warm', continuity: 'resumed', reviewId: 'lineage', priorSessionId: 'chat' },
    },
  };
  const result = { ...context(), currentHeadSha: 'b'.repeat(40) };
  configureWorkspaceContinuity({ ...current, id: 'next' }, source, result, undefined, [
    interrupted,
  ]);
  assert.equal(result.session?.fallback, undefined);
  assert.equal(result.priorReviewedHeadSha, 'a'.repeat(40));
  assert.equal(result.mode, 'warm');
  assert.equal(result.session?.priorRunId, interrupted.id);
  assert.equal(result.session?.sessionId, 'chat');
  for (const other of [
    { ...interrupted, status: 'monitoring' as const },
    { ...interrupted, nativeOwnerPrincipalId: 'foreign' },
    { ...interrupted, effort: 'high' },
  ]) {
    assert.throws(
      () =>
        configureWorkspaceContinuity(
          { ...current, id: 'next' },
          source,
          { ...context(), currentHeadSha: 'b'.repeat(40) },
          undefined,
          [other],
        ),
      /held by its successor/,
    );
  }
  const claudeCurrent = {
    ...current,
    id: 'next',
    metrics: { runner: 'claude', model: 'opus' },
  } as Run;
  const claudeSource = {
    ...source,
    agentContexts: [
      { ...source.agentContexts![0], runner: 'claude', model: 'opus', effort: 'high' },
    ],
  };
  const claudeInterrupted = {
    ...interrupted,
    metrics: { runner: 'claude', model: 'opus' },
    effort: 'high',
    agentContexts: claudeSource.agentContexts,
  } as Run;
  const claudeResult = { ...context(), currentHeadSha: 'b'.repeat(40) };
  configureWorkspaceContinuity(claudeCurrent, claudeSource, claudeResult, undefined, [
    claudeInterrupted,
  ]);
  assert.equal(claudeResult.session?.continuity, 'resumed');
  assert.throws(
    () =>
      configureWorkspaceContinuity(
        { ...claudeCurrent, effort: 'low' },
        claudeSource,
        { ...context(), currentHeadSha: 'b'.repeat(40) },
        undefined,
        [claudeInterrupted],
      ),
    /WARM review unavailable/,
  );
});

test('a historical ancestry diagnosis defers to pinned scope qualification', () => {
  const result = { ...context(), warmUnavailableReason: 'Rebased head' };
  configureWorkspaceContinuity(current, prior, result);
  assert.equal(result.mode, 'warm');
  assert.equal(result.session?.continuity, 'resumed');
});

test('workspace lineage normalizes current and prior GitHub pull URLs', () => {
  for (const currentTicket of ['example/app#42', 'https://github.com/example/app/pull/42'])
    for (const priorTicket of ['example/app#42', 'https://github.com/example/app/pull/42']) {
      const result = context();
      configureWorkspaceContinuity(
        { ...current, ticketOrPr: currentTicket },
        { ...prior, ticketOrPr: priorTicket },
        result,
      );
      assert.equal(result.session?.continuity, 'resumed');
      assert.equal(result.session?.sessionId, 'chat');
    }
});
