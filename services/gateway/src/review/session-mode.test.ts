import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { makeRun } from '../run-engine/test-fixtures.js';

import {
  claimWarmReviewerSession,
  invalidateWarmReviewerSessions,
  invalidateWarmReviewerSessionsForSlot,
  parseReviewMode,
  persistedWarmReviewerSession,
  registerWarmReviewerSession,
  resetWarmReviewerSessionsForTest,
  reviewPRIdentity,
  shouldRetainCompletedReviewer,
  type WarmReviewerScope,
} from './session-mode.js';

const scope: WarmReviewerScope = {
  reviewId: 'review-a',
  familyId: 'family-1',
  project: 'project',
  ownerPrincipalId: null,
  transport: 'tmux',
  runId: 'run-a',
  taskDir: 'tasks/a',
  artifactScope: null,
  runner: 'codex',
  model: 'gpt-6-astra',
  effort: null,
  repository: 'owner/repo',
  prNumber: 42,
};
const session = {
  ...scope,
  contextId: 'review-context',
  windowName: 'review-window',
  slotId: 'slot-a',
  runnerSessionId: 'session-a',
  runnerSessionPath: '/tmp/session-a.jsonl',
  lastLoopNumber: 1,
  lastReviewedHeadSha: '1111111',
};
beforeEach(resetWarmReviewerSessionsForTest);

test('only WARM/COLD mode choices parse; invalid configuration refuses', () => {
  assert.equal(parseReviewMode('cold'), 'cold');
  assert.equal(parseReviewMode('warm'), 'warm');
  assert.equal(parseReviewMode(undefined), undefined);
  assert.throws(() => parseReviewMode('resume'), /warm or cold/);
});

test('WARM retains repository/PR identity and last reviewed head across run and artifact IDs', () => {
  registerWarmReviewerSession(session);
  const claimed = claimWarmReviewerSession({
    ...scope,
    runId: 'run-b',
    taskDir: 'tasks/b',
    artifactScope: 'review-b',
  });
  assert.equal(claimed?.runnerSessionId, session.runnerSessionId);
  assert.equal(claimed?.lastReviewedHeadSha, session.lastReviewedHeadSha);
  assert.equal(claimed?.runId, 'run-a');
  assert.ok(claimWarmReviewerSession({ ...scope, repository: 'OWNER/REPO' }));
});

test('foreign PRs, families and runners never claim the retained reviewer', () => {
  registerWarmReviewerSession(session);
  assert.throws(
    () => claimWarmReviewerSession({ ...scope, repository: 'foreign/repo' }),
    /pr-mismatch/,
  );
  assert.throws(() => claimWarmReviewerSession({ ...scope, prNumber: 43 }), /pr-mismatch/);
  assert.throws(() => claimWarmReviewerSession({ ...scope, runner: 'claude' }), /runner-mismatch/);
  assert.equal(claimWarmReviewerSession({ ...scope, reviewId: 'another-review' }), null);
  assert.equal(claimWarmReviewerSession({ ...scope, familyId: 'another-family' }), null);
});

test('a pre-publish run registers its validated reviewer and a WARM re-review continues it', () => {
  const { repository: _repository, prNumber: _prNumber, ...prePublish } = scope;
  registerWarmReviewerSession({
    ...session,
    ...prePublish,
    repository: undefined,
    prNumber: undefined,
  });
  assert.equal(claimWarmReviewerSession(prePublish)?.runnerSessionId, session.runnerSessionId);
  // The lineage continues once the PR opens, and never in another run family.
  assert.equal(claimWarmReviewerSession(scope)?.runnerSessionId, session.runnerSessionId);
  assert.equal(claimWarmReviewerSession({ ...prePublish, familyId: 'family-2' }), null);
  const run = makeRun({
    id: 'prior-run',
    project: 'project',
    status: 'reviewing',
    slotId: 'slot-a',
    ticketOrPr: 'PROJ-1',
  });
  run.engineState = {
    publishGate: {
      reviews: [
        {
          id: 'review-a',
          runner: scope.runner,
          model: scope.model,
          mode: 'cold',
          verdict: 'issues',
          loopNumber: 1,
          unresolvedCount: 1,
          reviewerSessionId: session.runnerSessionId,
          reviewedHeadSha: session.lastReviewedHeadSha,
        },
      ],
    },
  };
  run.agentContexts = [
    {
      id: session.contextId,
      reviewId: scope.reviewId,
      role: 'review',
      label: 'Review',
      runId: 'prior-run',
      slotId: 'slot-a',
      runner: scope.runner,
      model: scope.model,
      status: 'complete',
      target: { session: 'tmux', window: session.windowName, target: 'tmux:review' },
      runnerSessionId: session.runnerSessionId,
      runnerSessionPath: session.runnerSessionPath,
      runnerSessionCapturedAt: 'captured',
      reviewResultValidatedAt: 'validated',
      taskFile: 'tasks/old/REVIEW.md',
    },
  ];
  resetWarmReviewerSessionsForTest();
  assert.equal(persistedWarmReviewerSession(prePublish, run)?.lastReviewedHeadSha, '1111111');
  assert.equal(persistedWarmReviewerSession({ ...prePublish, familyId: 'family-2' }, run), null);
});

test('busy WARM and unsupported model/effort changes visibly refuse', () => {
  registerWarmReviewerSession(session);
  assert.throws(() => claimWarmReviewerSession({ ...scope, model: 'different' }), /model-mismatch/);
  assert.throws(() => claimWarmReviewerSession({ ...scope, effort: 'high' }), /effort-mismatch/);
  claimWarmReviewerSession({ ...scope, runId: 'run-b' }, { consume: true });
  assert.throws(() => claimWarmReviewerSession(scope), /session-busy/);
  assert.equal(invalidateWarmReviewerSessions('run-b'), 1);
  assert.equal(claimWarmReviewerSession(scope), null);
});

test('successful COLD is retained for later WARM while invalid sessions remain forensic', () => {
  assert.equal(shouldRetainCompletedReviewer(true), true);
  assert.equal(shouldRetainCompletedReviewer(false), false);
  registerWarmReviewerSession(session);
  assert.equal(invalidateWarmReviewerSessionsForSlot('slot-a'), 0);
  assert.equal(claimWarmReviewerSession(scope)?.runnerSessionId, session.runnerSessionId);
  claimWarmReviewerSession(scope, { consume: true });
  assert.equal(invalidateWarmReviewerSessionsForSlot('slot-a'), 1);
  assert.equal(claimWarmReviewerSession(scope), null);
  assert.throws(
    () => registerWarmReviewerSession({ ...session, lastReviewedHeadSha: '' }),
    /last reviewed head/,
  );
});

test('restart recovery requires completed separate session and matching verdict/head provenance', () => {
  const context = {
    id: session.contextId,
    reviewId: scope.reviewId,
    role: 'review' as const,
    label: 'Review',
    runId: 'prior-run',
    slotId: 'slot-a',
    runner: scope.runner,
    model: scope.model,
    status: 'complete' as const,
    target: { session: 'tmux', window: session.windowName, target: 'tmux:review' },
    runnerSessionId: session.runnerSessionId,
    runnerSessionPath: session.runnerSessionPath,
    runnerSessionCapturedAt: 'captured',
    reviewResultValidatedAt: 'validated',
    taskFile: 'tasks/old/REVIEW.md',
  };
  const run = makeRun({
    id: 'prior-run',
    project: 'project',
    status: 'done',
    slotId: 'slot-a',
    ticketOrPr: 'owner/repo#42',
    engineState: {
      generation: 1,
      stepIndex: 0,
      status: 'completed',
      publishGate: {
        reviews: [
          {
            id: 'review-a',
            source: 'pipeline',
            runner: scope.runner,
            model: scope.model,
            mode: 'cold',
            verdict: 'issues',
            loopNumber: 1,
            unresolvedCount: 1,
            reviewerSessionId: session.runnerSessionId,
            reviewedHeadSha: session.lastReviewedHeadSha,
          },
        ],
      },
    } as never,
  });
  run.agentContexts = [context];
  assert.equal(persistedWarmReviewerSession(scope, run)?.runId, 'prior-run');
  assert.equal(persistedWarmReviewerSession(scope, { ...run, ticketOrPr: 'owner/repo#43' }), null);
  assert.equal(
    persistedWarmReviewerSession(scope, {
      ...run,
      agentContexts: [{ ...context, role: 'primary' }],
    }),
    null,
  );
  assert.equal(
    persistedWarmReviewerSession(scope, {
      ...run,
      agentContexts: [{ ...context, status: 'working' }],
    }),
    null,
  );
  assert.equal(persistedWarmReviewerSession(scope, { ...run, engineState: undefined }), null);
  const owned = (generation?: number) => ({
    ...run,
    createdByPrincipalId: 'owner',
    createdByPrincipalGeneration: generation,
  });
  const ownerScope = (generation?: number) => ({
    ...scope,
    ownerPrincipalId: 'owner',
    ownerPrincipalGeneration: generation,
  });
  assert.equal(persistedWarmReviewerSession(ownerScope(1), owned()), null);
  assert.equal(persistedWarmReviewerSession(ownerScope(), owned(1)), null);
  assert.equal(persistedWarmReviewerSession(ownerScope(1), owned(1))?.runId, 'prior-run');
});

test('multiple reviewer lineages for one PR never select the latest unrelated review', () => {
  registerWarmReviewerSession(session);
  registerWarmReviewerSession({
    ...session,
    reviewId: 'review-b',
    runnerSessionId: 'session-b',
    lastReviewedHeadSha: '2222222',
  });
  assert.equal(claimWarmReviewerSession(scope)?.runnerSessionId, 'session-a');
  assert.equal(
    claimWarmReviewerSession({ ...scope, reviewId: 'review-b' })?.runnerSessionId,
    'session-b',
  );
  assert.equal(claimWarmReviewerSession({ ...scope, reviewId: '' }), null);
  assert.throws(
    () => claimWarmReviewerSession({ ...scope, ownerPrincipalId: 'foreign' }),
    /incompatible project, owner or transport/,
  );
  assert.throws(
    () => claimWarmReviewerSession({ ...scope, ownerPrincipalGeneration: 1 }),
    /incompatible project, owner or transport/,
  );
});

test('canonical review identity accepts stored PR links and qualified references', () => {
  const run = makeRun({
    ticketOrPr: 'MANUAL-review',
    links: [{ label: 'PR', url: 'https://github.com/owner/repo/pull/42' }],
  });
  assert.deepEqual(reviewPRIdentity(run), { repository: 'owner/repo', prNumber: 42 });
  assert.deepEqual(reviewPRIdentity({ ...run, links: [], ticketOrPr: 'owner/repo#42' }), {
    repository: 'owner/repo',
    prNumber: 42,
  });
});
