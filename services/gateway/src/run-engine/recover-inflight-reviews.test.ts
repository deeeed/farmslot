import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  type AgentContext,
  type NativeSessionReadResult,
  type Principal,
  reviewRoundBudgetLabel,
  type ReviewStatus,
  type WorkerSignal,
} from '@farmslot/protocol';

import {
  admitReviewRound,
  reviewRoundAdmissionId,
  runReviewRoundBudget,
} from '../review/review-round-budget.js';
import { makeVars } from '../runners/test-fixtures.js';
import { createRun, getRun, updateRun } from '../runs/store.js';
import { runWithSessionOriginator } from '../security/work-originator.js';

import { reviewFinalSnapshotMatchesPreparedPackage } from './gate-policy.js';
import {
  appendRecoveredContinuationAttempt,
  buildRecoveredReview,
  isRecoverableReviewerContext,
  normalizeExhaustedReviewContinuationsForRun,
  publicationReviewRecoveryNeedsReplay,
  recoveredReviewAlreadyIngested,
  recoveredReviewArtifactScope,
  recoveredReviewerActionForPromptRecovery,
  recoverInflightPublicationReviews,
  reviewerContextIsSettled,
  reviewerContextNeedsRecovery,
} from './recover-inflight-reviews.js';
import { deleteTestRunIfPresent, makeReadyGatePackage, makeRun } from './test-fixtures.js';

test('an already-ingested ISSUES verdict restores its operator gate instead of polling forever', () => {
  const result = { recoveredIds: [], terminalErrors: [] };
  const review: ReviewStatus = {
    id: 'retained-review',
    source: 'human-gate',
    mode: 'cold',
    loopNumber: 1,
    verdict: 'issues',
    unresolvedCount: 1,
    issues: [{ file: 'icon.service.ts', description: 'exponential SVG parsing' }],
    feedbackSent: false,
    recoveryContinuationPending: true,
  };
  assert.equal(publicationReviewRecoveryNeedsReplay(result, [review]), true);
  assert.equal(publicationReviewRecoveryNeedsReplay(result), false);
  assert.equal(
    publicationReviewRecoveryNeedsReplay(result, [{ ...review, feedbackSent: true }]),
    false,
  );
  assert.equal(
    publicationReviewRecoveryNeedsReplay(result, [{ ...review, maxRetriesExhausted: true }]),
    false,
  );
  assert.equal(
    publicationReviewRecoveryNeedsReplay(result, [
      review,
      { ...review, id: 'later-pass', verdict: 'pass', unresolvedCount: 0, issues: [] },
    ]),
    false,
  );
  for (const change of [
    { recoveredIds: ['review'] },
    { repairedIds: ['review'] },
    { relaunchIds: ['review'] },
  ]) {
    assert.equal(publicationReviewRecoveryNeedsReplay({ ...result, ...change }), true);
  }
});

test('retired reviewer recovery requests a fresh launch for the same artifact scope', () => {
  assert.deepEqual(
    recoveredReviewerActionForPromptRecovery('retired', {
      id: 'rev-cursor',
      artifactScope: 'review-2',
    }),
    { kind: 'relaunch', id: 'review-2' },
  );
  assert.equal(
    recoveredReviewerActionForPromptRecovery('indeterminate', {
      id: 'rev-cursor',
      artifactScope: 'review-2',
    }),
    null,
  );
});

test('exhausted review continuations are normalized and persisted once per recovery pass', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'owner/repo#4242',
    runner: 'claude',
    slotId: 'remote-mobile-1',
  });
  t.after(() => deleteTestRunIfPresent(run.id));

  const exhausted: ReviewStatus = {
    reviewerSessionId: 'fixture-session-' + 'extra-review-1',
    reviewedHeadSha: 'fixture-head',
    mode: 'cold' as const,
    id: 'extra-review-1',
    source: 'human-gate',
    loopNumber: 1,
    verdict: 'issues',
    unresolvedCount: 1,
    issues: [{ file: 'a.ts', description: 'unresolved' }],
    feedbackSent: true,
    attempts: [{ mode: 'cold' as const, loopNumber: 1, verdict: 'issues', unresolvedCount: 1 }],
  };
  updateRun(run.id, { engineState: { publishGate: { reviews: [exhausted] } } });

  const normalized = normalizeExhaustedReviewContinuationsForRun(run.id);
  assert.equal(normalized[0].feedbackSent, false);
  assert.equal(normalized[0].recoveryContinuationPending, true);
  assert.deepEqual(getRun(run.id)?.engineState?.publishGate?.reviews, normalized);

  // Idempotent: the second entry point over already-normalized reviews returns
  // the stored array untouched rather than rewriting it.
  const second = normalizeExhaustedReviewContinuationsForRun(run.id);
  assert.equal(second, getRun(run.id)?.engineState?.publishGate?.reviews);
});

test('recovery ignores the same terminal reviewer signal but accepts a later continuation', () => {
  assert.equal(
    recoveredReviewAlreadyIngested(
      {
        completedAt: '2026-08-03T16:00:00.000Z',
        verdict: 'pass',
        unresolvedCount: 0,
      },
      {
        completedAt: '2026-08-03T16:00:00.000Z',
        verdict: 'pass',
        unresolvedCount: 0,
      },
    ),
    true,
  );
  assert.equal(
    recoveredReviewAlreadyIngested(
      {
        completedAt: '2026-08-03T16:00:00.000Z',
        verdict: 'pass',
        unresolvedCount: 0,
      },
      {
        completedAt: '2026-08-03T16:05:00.000Z',
        verdict: 'pass',
        unresolvedCount: 0,
      },
    ),
    false,
  );
});

test('recovery replaces a skipped placeholder with an authoritative reviewer verdict', () => {
  assert.equal(
    recoveredReviewAlreadyIngested(
      {
        completedAt: '2026-08-03T16:05:00.000Z',
        verdict: 'skipped',
        unresolvedCount: 0,
      },
      {
        completedAt: '2026-08-03T16:00:00.000Z',
        verdict: 'issues',
        unresolvedCount: 2,
      },
    ),
    false,
  );
});

test('recovery never lets an older authoritative verdict replace a newer one', () => {
  assert.equal(
    recoveredReviewAlreadyIngested(
      {
        completedAt: '2026-08-03T16:05:00.000Z',
        verdict: 'issues',
        unresolvedCount: 2,
      },
      {
        completedAt: '2026-08-03T16:00:00.000Z',
        verdict: 'pass',
        unresolvedCount: 0,
      },
    ),
    true,
  );
});

test('attempt identity wins over inverted completion clocks', () => {
  assert.equal(
    recoveredReviewAlreadyIngested(
      {
        completedAt: '2026-08-03T16:05:00.000Z',
        verdict: 'issues',
        unresolvedCount: 1,
        attempts: [
          {
            mode: 'cold' as const,
            loopNumber: 1,
            startedAt: '2026-08-03T16:00:00.000Z',
            verdict: 'issues',
            unresolvedCount: 1,
          },
        ],
      },
      {
        completedAt: '2026-08-03T16:04:00.000Z',
        verdict: 'pass',
        unresolvedCount: 0,
        attempts: [
          {
            mode: 'cold' as const,
            loopNumber: 1,
            startedAt: '2026-08-03T16:03:00.000Z',
            verdict: 'pass',
            unresolvedCount: 0,
          },
        ],
      },
    ),
    false,
  );
});

test('recovery deduplicates one review generation even when its terminal signal is later', () => {
  const attempt = {
    mode: 'cold' as const,
    loopNumber: 4,
    verdict: 'issues' as const,
    unresolvedCount: 2,
    startedAt: '2026-08-03T15:30:00.000Z',
  };
  assert.equal(
    recoveredReviewAlreadyIngested(
      {
        completedAt: '2026-08-03T16:00:00.000Z',
        verdict: 'issues',
        unresolvedCount: 2,
        attempts: [attempt],
      },
      {
        completedAt: '2026-08-03T16:00:00.400Z',
        verdict: 'issues',
        unresolvedCount: 2,
        attempts: [attempt],
      },
    ),
    true,
  );
  assert.equal(
    recoveredReviewAlreadyIngested(
      {
        completedAt: '2026-08-03T16:00:00.000Z',
        verdict: 'issues',
        unresolvedCount: 2,
        attempts: [attempt],
      },
      {
        completedAt: '2026-08-03T16:05:00.000Z',
        verdict: 'pass',
        unresolvedCount: 0,
        attempts: [{ ...attempt, startedAt: '2026-08-03T16:01:00.000Z', verdict: 'pass' }],
      },
    ),
    false,
  );
});

test('recovery replaces a later failed delivery placeholder with the reviewer verdict', () => {
  assert.equal(
    recoveredReviewAlreadyIngested(
      {
        completedAt: '2026-08-03T16:05:00.000Z',
        verdict: 'failed',
        unresolvedCount: 0,
        feedbackSent: false,
        recoveryContinuationPending: true,
      },
      { completedAt: '2026-08-03T16:00:00.000Z' },
    ),
    false,
  );
});

function reviewerContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    id: overrides.id ?? 'rev-abc',
    role: overrides.role ?? 'review',
    label: overrides.label ?? 'Reviewer',
    status: overrides.status ?? 'working',
    slotId: overrides.slotId ?? 'slot-1',
    runId: overrides.runId ?? 'run-1',
    taskFile: 'taskFile' in overrides ? overrides.taskFile : 'tasks/PROJ-1/REVIEW.rev-abc.md',
    signalFile:
      'signalFile' in overrides ? overrides.signalFile : 'tasks/PROJ-1/REVIEW.rev-abc-SIGNAL.json',
    runner: overrides.runner ?? 'codex',
    model: overrides.model ?? 'gpt-5.5',
    startedAt: overrides.startedAt ?? '2026-07-16T10:00:00.000Z',
    ...overrides,
  };
}

function terminalSignal(overrides: Partial<WorkerSignal> = {}): WorkerSignal {
  return {
    role: 'review',
    status: overrides.status ?? 'complete',
    outcome: overrides.outcome,
    timestamp: overrides.timestamp ?? '2026-07-16T10:40:00.000Z',
    ...overrides,
  };
}

test('isRecoverableReviewerContext keeps failed reviewers out of the long-lived watcher', () => {
  assert.equal(isRecoverableReviewerContext({ role: 'review', status: 'working' }), true);
  assert.equal(isRecoverableReviewerContext({ role: 'review', status: 'launching' }), true);
  assert.equal(isRecoverableReviewerContext({ role: 'review', status: 'complete' }), true);
  assert.equal(isRecoverableReviewerContext({ role: 'review', status: 'failed' }), false);
  assert.equal(
    isRecoverableReviewerContext({ role: 'review', status: 'failed' }, { includeFailed: true }),
    true,
  );
  // Other roles never produce a publish-gate review.
  assert.equal(isRecoverableReviewerContext({ role: 'primary', status: 'working' }), false);
  assert.equal(isRecoverableReviewerContext({ role: 'review-fix', status: 'working' }), false);
});

test('reviewerContextNeedsRecovery deduplicates completed contexts by artifact scope', () => {
  const complete = reviewerContext({
    status: 'complete',
    artifactScope: 'review-7',
  });
  assert.equal(reviewerContextNeedsRecovery(complete, []), true);
  assert.equal(reviewerContextNeedsRecovery(complete, [{ id: 'review-7' }]), false);
  assert.equal(
    reviewerContextNeedsRecovery(complete, [
      {
        id: 'review-7',
        source: 'dispatch',
        verdict: 'issues',
        unresolvedCount: 1,
        feedbackSent: false,
        recoveryContinuationPending: true,
        issues: [{ file: 'src/example.ts', description: 'Fix this issue' }],
      },
    ]),
    true,
    'a completed reviewer may contain a newer fix-pass artifact for the same review id',
  );
  assert.equal(
    reviewerContextNeedsRecovery(complete, [
      {
        id: 'review-7',
        source: 'dispatch',
        verdict: 'issues',
        unresolvedCount: 1,
        feedbackSent: false,
        issues: [{ file: 'src/example.ts', description: 'Fix this issue' }],
      },
    ]),
    false,
    'a terminal issues verdict without an explicit recovery continuation stays terminal',
  );
  assert.equal(
    reviewerContextNeedsRecovery(complete, [
      {
        id: 'review-7',
        source: 'human-gate',
        verdict: 'issues',
        unresolvedCount: 6,
        feedbackSent: false,
        recoveryContinuationPending: true,
        retryCount: 3,
        maxRetries: 3,
        issues: [{ file: 'src/example.ts', description: 'still broken' }],
      },
    ]),
    false,
    'an exhausted retry cap is not a pending continuation',
  );
  assert.equal(
    reviewerContextNeedsRecovery(reviewerContext({ status: 'complete', artifactScope: null }), []),
    false,
  );
  assert.equal(
    reviewerContextNeedsRecovery(reviewerContext({ status: 'working', artifactScope: null }), []),
    true,
  );
  assert.equal(
    reviewerContextNeedsRecovery(complete, [
      {
        id: 'review-7',
        source: 'dispatch',
        verdict: 'issues',
        unresolvedCount: 1,
        feedbackSent: false,
        recoveryContinuationPending: true,
        issues: [{ file: 'src/example.ts', description: 'Fix this issue' }],
      },
      {
        id: 'review-8',
        source: 'dispatch',
        verdict: 'pass',
        unresolvedCount: 0,
      },
    ]),
    false,
    'a later terminal review supersedes an older continuation marker',
  );
  assert.equal(
    reviewerContextNeedsRecovery(complete, [
      {
        id: 'review-7',
        source: 'human-gate',
        verdict: 'skipped',
        unresolvedCount: 0,
      },
      {
        id: 'review-8',
        source: 'human-gate',
        verdict: 'skipped',
        unresolvedCount: 0,
      },
    ]),
    true,
    'a later skipped placeholder does not suppress an authoritative reviewer artifact',
  );
  for (const verdict of ['failed', 'cancelled'] as const) {
    assert.equal(
      reviewerContextNeedsRecovery(complete, [
        {
          id: 'review-7',
          source: 'human-gate',
          verdict: 'skipped',
          unresolvedCount: 0,
        },
        {
          id: 'review-8',
          source: 'human-gate',
          verdict,
          unresolvedCount: 0,
        },
      ]),
      true,
      `a later ${verdict} attempt does not suppress the reviewer-owned verdict`,
    );
  }
  assert.equal(
    reviewerContextNeedsRecovery(complete, [
      {
        id: 'review-7',
        source: 'human-gate',
        verdict: 'issues',
        unresolvedCount: 2,
        feedbackSent: false,
      },
    ]),
    false,
    'recovery converges once the skipped placeholder is replaced by a terminal verdict',
  );
});

test('a warm attempt is not settled by its lineage result from before that attempt', () => {
  const context = reviewerContext({
    status: 'working',
    artifactScope: 'pipeline-review',
    attemptStartedAt: '2026-10-21T08:44:08.406Z',
  });
  const review: ReviewStatus = {
    id: 'pipeline-review',
    source: 'pipeline',
    mode: 'warm',
    loopNumber: 1,
    verdict: 'issues',
    unresolvedCount: 1,
    completedAt: '2026-10-21T02:52:07.913Z',
    attempts: [
      {
        loopNumber: 2,
        mode: 'warm',
        verdict: 'issues',
        unresolvedCount: 1,
        completedAt: '2026-10-21T02:52:07.913Z',
      },
      {
        loopNumber: 3,
        mode: 'cold',
        verdict: 'failed',
        unresolvedCount: 1,
        completedAt: '2026-10-21T02:54:20.378Z',
      },
    ],
  };
  assert.equal(reviewerContextIsSettled(context, [review]), false);
  assert.equal(reviewerContextNeedsRecovery(context, [review]), true);
  assert.equal(reviewerContextNeedsRecovery({ ...context, status: 'complete' }, [review]), true);
  const recovered: ReviewStatus = {
    ...review,
    completedAt: '2026-10-21T08:50:11.355Z',
    attempts: [
      {
        loopNumber: 4,
        mode: 'warm',
        verdict: 'issues',
        unresolvedCount: 1,
        startedAt: context.attemptStartedAt,
        completedAt: '2026-10-21T08:50:11.355Z',
      },
    ],
  };
  const retained = appendRecoveredContinuationAttempt(
    { ...review, maxRetries: 2, maxRetriesExhausted: true },
    recovered,
  );
  assert.deepEqual(retained.attempts?.slice(0, 2), review.attempts);
  assert.equal(retained.attempts?.at(-1)?.loopNumber, 4);
  assert.equal(retained.completedAt, recovered.completedAt);
});

test('a falsely complete newer native attempt remains collecting while its own command is running', async (t) => {
  const previousOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'owner';
  t.after(() => {
    if (previousOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previousOwner;
  });
  const vars = makeVars({ remoteRepo: os.tmpdir() });
  const run = createRun(
    {
      project: 'example-mobile-farm',
      flowType: 'dev',
      ticketOrPr: 'UNIT-NATIVE-COLLECTION',
      slotId: vars.slotId,
    },
    { nativeOwnerPrincipalId: 'owner' },
  );
  const context = reviewerContext({
    runId: run.id,
    slotId: vars.slotId,
    status: 'complete',
    artifactScope: 'pipeline-review',
    attemptStartedAt: '2026-10-21T08:44:08.406Z',
    nativeSession: {
      sessionId: 'native-session',
      commandId: 'current-command',
      generation: 'current-generation',
      leaseId: 'lease',
      executionNodeId: 'node',
      ownerPrincipalId: 'owner',
    },
  });
  t.after(async () => {
    updateRun(run.id, {
      agentContexts: [
        {
          ...context,
          nativeSession: { ...context.nativeSession!, closedAt: new Date().toISOString() },
        },
      ],
    });
    await deleteTestRunIfPresent(run.id);
  });
  const review: ReviewStatus = {
    id: 'pipeline-review',
    source: 'pipeline',
    mode: 'warm',
    loopNumber: 1,
    verdict: 'issues',
    unresolvedCount: 1,
    completedAt: '2026-10-21T02:52:07.913Z',
  };
  updateRun(run.id, {
    agentContexts: [context],
    engineState: { publishGate: { reviews: [review] } },
  });
  const snapshot: NativeSessionReadResult = {
    session: {
      id: 'native-session',
      generation: 'current-generation',
      hostPid: 10,
      runner: 'codex',
      nativeSessionId: 'conversation',
      ownerPrincipalId: 'owner',
      executionNodeId: 'node',
      accountContextId: 'account',
      cwd: '/tmp/fixture',
      executable: 'codex',
      version: 'fixture',
      mode: 'default',
      accountMode: 'native',
      state: 'running',
      capabilities: {
        modes: ['default'],
        streaming: true,
        tools: true,
        approvals: false,
        questions: false,
        interrupt: true,
        resume: true,
      },
    },
    events: [],
    cursor: 0,
    hasMore: false,
    pendingRequests: [],
    commands: [
      {
        commandId: 'current-command',
        generation: 'current-generation',
        state: 'accepted',
        submitted: true,
        accepted: true,
      },
    ],
  };
  const result = await recoverInflightPublicationReviews(run.id, vars.slotId, {
    readers: {
      slot: async () => vars,
      config: async () => ({ enabled: true }),
      package: async () => undefined,
      native: async () => snapshot,
    },
  });
  assert.deepEqual(result.recoveredIds, []);
  assert.equal(getRun(run.id)!.agentContexts?.[0]?.status, 'working');
  assert.deepEqual(getRun(run.id)!.engineState?.publishGate?.reviews, [review]);
  assert.equal(getRun(run.id)!.reviewRoundAdmissions?.length ?? 0, 0);

  let stopped = false;
  t.mock.module('../runners/native/worker.js', {
    namedExports: {
      ...(await import('../runners/native/worker.js')),
      cancelNativeWorkerContext: async () => {
        stopped = true;
      },
    },
  });
  snapshot.commands[0] = { ...snapshot.commands[0]!, state: 'failed', outcome: 'failed' };
  snapshot.events = [
    {
      sessionId: 'native-session',
      generation: 'current-generation',
      commandId: 'current-command',
      sequence: 1,
      at: new Date().toISOString(),
      type: 'error',
      text: 'Provider refused this request: cybersecurity policy',
      data: { error: { codexErrorInfo: 'cyberPolicy' }, willRetry: false },
    },
  ];
  const completion = await import('../review/native-review-completion.js');
  let completionCalls = 0;
  const eligible = t.mock.module('../review/native-review-completion.js', {
    namedExports: {
      ...completion,
      continueNativeReviewCompletion: async () => {
        completionCalls++;
        return 'continued';
      },
    },
  });
  await recoverInflightPublicationReviews(run.id, vars.slotId, {
    readers: {
      slot: async () => vars,
      config: async () => ({ enabled: true }),
      package: async () => undefined,
      native: async () => snapshot,
    },
  });
  assert.equal(
    completionCalls,
    1,
    'A failed command with valid findings still reaches its completion turn',
  );
  assert.equal(stopped, false);
  eligible.restore();
  await recoverInflightPublicationReviews(run.id, vars.slotId, {
    readers: {
      slot: async () => vars,
      config: async () => ({ enabled: true }),
      package: async () => undefined,
      native: async () => snapshot,
    },
  });
  assert.equal(stopped, true);
  assert.equal(getRun(run.id)!.agentContexts?.[0]?.status, 'failed');
  assert.equal(
    getRun(run.id)!.agentContexts?.[0]?.error,
    'Provider refused this request: cybersecurity policy',
  );
  assert.deepEqual(getRun(run.id)!.engineState?.publishGate?.reviews, [review]);
});

test('reviewerContextIsSettled terminalizes persisted and superseded reviewer ghosts', () => {
  const working = reviewerContext({
    status: 'working',
    artifactScope: 'review-7',
  });
  assert.equal(
    reviewerContextIsSettled(working, [
      {
        id: 'review-7',
        source: 'dispatch',
        verdict: 'pass',
        unresolvedCount: 0,
      },
    ]),
    true,
    'a persisted terminal verdict settles its lingering reviewer context',
  );
  assert.equal(
    reviewerContextIsSettled(working, [
      {
        id: 'review-7',
        source: 'dispatch',
        verdict: 'issues',
        unresolvedCount: 1,
        feedbackSent: false,
        recoveryContinuationPending: true,
        issues: [{ file: 'src/example.ts', description: 'Fix this issue' }],
      },
    ]),
    false,
    'the current review remains live while its continuation is pending',
  );
  assert.equal(
    reviewerContextIsSettled(working, [
      {
        id: 'review-7',
        source: 'dispatch',
        verdict: 'issues',
        unresolvedCount: 1,
        feedbackSent: false,
        recoveryContinuationPending: true,
        issues: [{ file: 'src/example.ts', description: 'Fix this issue' }],
      },
      {
        id: 'review-8',
        source: 'dispatch',
        verdict: 'pass',
        unresolvedCount: 0,
      },
    ]),
    true,
    'a later persisted review supersedes an older pending continuation',
  );
  assert.equal(
    reviewerContextIsSettled(reviewerContext({ status: 'complete', artifactScope: 'review-7' }), [
      { id: 'review-7', verdict: 'pass', unresolvedCount: 0 },
    ]),
    false,
  );
});

test('a one-shot scan only replaces an explicitly recoverable failed placeholder', () => {
  const failed = reviewerContext({
    status: 'failed',
    artifactScope: 'review-7',
  });
  assert.equal(
    reviewerContextNeedsRecovery(failed, [], { includeFailed: true }),
    false,
    'a failed reviewer without a delivery placeholder is terminal',
  );
  assert.equal(
    reviewerContextNeedsRecovery(failed, [
      {
        id: 'review-7',
        verdict: 'failed',
        unresolvedCount: 0,
        feedbackSent: false,
      },
    ]),
    false,
  );
  assert.equal(
    reviewerContextNeedsRecovery(
      failed,
      [
        {
          id: 'review-7',
          verdict: 'failed',
          unresolvedCount: 0,
          feedbackSent: false,
          recoveryContinuationPending: true,
        },
      ],
      { includeFailed: true },
    ),
    true,
  );
  assert.equal(
    reviewerContextNeedsRecovery(
      failed,
      [
        {
          id: 'review-7',
          source: 'dispatch',
          verdict: 'failed',
          unresolvedCount: 0,
          feedbackSent: false,
          recoveryContinuationPending: true,
        },
        {
          id: 'review-8',
          source: 'dispatch',
          verdict: 'issues',
          unresolvedCount: 1,
          feedbackSent: false,
        },
      ],
      { includeFailed: true },
    ),
    false,
    'a failed placeholder is superseded once a later review settled',
  );
  assert.equal(
    reviewerContextNeedsRecovery(
      failed,
      [
        {
          id: 'review-7',
          verdict: 'failed',
          unresolvedCount: 0,
          feedbackSent: false,
        },
      ],
      { includeFailed: true },
    ),
    false,
    'a genuine terminal failure is not overwritten by unrelated artifacts',
  );
  assert.equal(
    reviewerContextNeedsRecovery(
      failed,
      [
        {
          id: 'review-7',
          verdict: 'issues',
          unresolvedCount: 1,
          feedbackSent: false,
        },
      ],
      { includeFailed: true },
    ),
    false,
  );
});

test('delivery-failed reviewer can recover from a later fresh complete signal', () => {
  const review = buildRecoveredReview({
    run: makeRun({ engineState: { publishGate: { reviews: [] } } }),
    ctx: reviewerContext({
      status: 'failed',
      artifactScope: 'review-7',
      attemptStartedAt: '2026-07-16T10:00:00.000Z',
    }),
    signal: terminalSignal({
      status: 'complete',
      timestamp: '2026-07-16T10:40:00.000Z',
    }),
    feedback: {
      verdict: 'issues',
      issues: [{ file: 'artifacts/pr-description.md', description: 'Fix stale ADR number' }],
    },
    reviewedPackage: undefined,
  });

  assert.ok(review);
  assert.equal(review.id, 'review-7');
  assert.equal(review.verdict, 'issues');
  assert.equal(review.unresolvedCount, 1);
});

test('restart recovery uses the reviewer-owned artifact scope instead of review-array length', () => {
  assert.equal(recoveredReviewArtifactScope({ artifactScope: 'review-7' }, 'review-2'), 'review-7');
  assert.equal(recoveredReviewArtifactScope({}, 'review-2'), 'review-2');
});

test('restart recovery uses attempt ordinals in a later requested review', () => {
  const previousHead = 'b'.repeat(40);
  const pkg = makeReadyGatePackage({
    headSha: 'c'.repeat(40),
    reviewSnapshot: {
      source: 'local-git',
      baseRef: 'origin/main',
      baseSha: 'a'.repeat(40),
      headSha: 'c'.repeat(40),
      diffHash: 'full-contribution',
      capturedAt: '2026-07-16T10:30:00.000Z',
    },
  });
  const previous: ReviewStatus = {
    id: 'review-2',
    source: 'human-gate',
    loopNumber: 2,
    mode: 'cold',
    verdict: 'issues',
    unresolvedCount: 1,
    reviewedHeadSha: previousHead,
    reviewerSessionId: 'retained-session',
    attempts: [{ loopNumber: 1, mode: 'cold', verdict: 'issues', unresolvedCount: 1 }],
    session: {
      mode: 'cold',
      continuity: 'fresh',
      reviewId: 'review-2',
      sessionId: 'retained-session',
      lastReviewedHeadSha: previousHead,
    },
  };
  const run = makeRun({ engineState: { publishGate: { reviews: [previous] } } });
  const ctx = reviewerContext({
    status: 'complete',
    artifactScope: 'review-2',
    reviewId: 'review-2',
    reviewLoopNumber: 2,
    runnerSessionId: 'retained-session',
    attemptStartedAt: '2026-07-16T10:30:00.000Z',
  });
  const params = {
    run,
    ctx,
    signal: terminalSignal(),
    feedback: { verdict: 'pass' as const, issues: [] },
    reviewSnapshot: { ...pkg.reviewSnapshot!, baseSha: previousHead, diffHash: 'reviewed-delta' },
    reviewedPackage: pkg,
  };
  const recovered = buildRecoveredReview(params);
  assert.ok(recovered);
  assert.equal(recovered.mode, 'warm');
  assert.equal(recovered.attempts?.[0]?.mode, 'warm');
  assert.equal(recovered.session?.continuity, 'resumed');
  assert.equal(recovered.session?.lastReviewedHeadSha, previousHead);
  assert.equal(reviewFinalSnapshotMatchesPreparedPackage(recovered, pkg), true);
  const appended = appendRecoveredContinuationAttempt(
    { ...previous, maxRetriesExhausted: true },
    recovered,
  );
  assert.equal(appended.loopNumber, 2, 'the aggregate review row ordinal stays unchanged');
  assert.deepEqual(
    appended.attempts?.map((attempt) => attempt.loopNumber),
    [1, 2],
  );
  assert.deepEqual(appended.attempts?.[0], previous.attempts?.[0]);

  const fallback = buildRecoveredReview({
    ...params,
    ctx: {
      ...ctx,
      runnerSessionId: 'fresh-session',
      reviewFallback: {
        reason: 'missing-session',
        detail: 'Retained session unavailable',
        comparedRanges: [`${previousHead}..${pkg.headSha}`],
      },
    },
  });
  assert.ok(fallback);
  assert.equal(fallback.mode, 'cold');
  assert.equal(fallback.session?.continuity, 'fresh');
  assert.equal(reviewFinalSnapshotMatchesPreparedPackage(fallback, pkg), true);
});

test('buildRecoveredReview preserves the reviewer-owned artifact scope as the review id', () => {
  const review = buildRecoveredReview({
    run: makeRun({ engineState: { publishGate: { reviews: [] } } }),
    ctx: reviewerContext({ artifactScope: 'review-7' }),
    signal: terminalSignal(),
    feedback: { verdict: 'pass', issues: [] },
    reviewedPackage: undefined,
  });

  assert.ok(review);
  assert.equal(review.id, 'review-7');
  assert.equal(review.loopNumber, 7);
});

test('buildRecoveredReview returns null when the reviewer has not finished', () => {
  const run = makeRun();
  const ctx = reviewerContext();
  const feedback = { verdict: 'issues' as const, issues: [{ file: 'a.ts', description: 'bad' }] };

  // No signal at all — reviewer still running.
  assert.equal(
    buildRecoveredReview({ run, ctx, signal: undefined, feedback, reviewedPackage: undefined }),
    null,
  );
  // Signal older than the reviewer context — a stale file from a prior loop.
  assert.equal(
    buildRecoveredReview({
      run,
      ctx,
      signal: terminalSignal({ timestamp: '2026-07-16T09:59:00.000Z' }),
      feedback,
      reviewedPackage: undefined,
    }),
    null,
  );
  // Terminal signal but feedback never parsed into a verdict.
  assert.equal(
    buildRecoveredReview({
      run,
      ctx,
      signal: terminalSignal(),
      feedback: { verdict: 'pass', issues: [], incomplete: true },
      reviewedPackage: undefined,
    }),
    null,
  );
});

test('buildRecoveredReview accepts fresh completed runtime context when terminal signal was lost', () => {
  const run = makeRun({ engineState: { publishGate: { reviews: [] } } });
  const ctx = reviewerContext({
    status: 'complete',
    attemptStartedAt: '2026-07-16T10:00:00.000Z',
    completedAt: '2026-07-16T10:40:00.000Z',
  });
  const review = buildRecoveredReview({
    run,
    ctx,
    signal: undefined,
    feedback: { verdict: 'issues', issues: [{ file: 'a.ts', description: 'bug' }] },
    reviewedPackage: undefined,
  });

  assert.ok(review);
  assert.equal(review.verdict, 'issues');
});

test('buildRecoveredReview accepts signal-less completion for an attempt-scoped context', () => {
  const review = buildRecoveredReview({
    run: makeRun({ engineState: { publishGate: { reviews: [] } } }),
    ctx: reviewerContext({
      status: 'complete',
      signalAttemptId: 'attempt-2',
      attemptStartedAt: '2026-07-16T10:00:00.000Z',
      completedAt: '2026-07-16T10:40:00.000Z',
    }),
    signal: undefined,
    feedback: { verdict: 'pass', issues: [] },
    reviewedPackage: undefined,
  });

  assert.equal(review?.verdict, 'pass');
});

test('buildRecoveredReview rejects a terminal signal from another attempt', () => {
  const review = buildRecoveredReview({
    run: makeRun({ engineState: { publishGate: { reviews: [] } } }),
    ctx: reviewerContext({
      status: 'complete',
      signalAttemptId: 'attempt-2',
      attemptStartedAt: '2026-07-16T10:00:00.000Z',
      completedAt: '2026-07-16T10:40:00.000Z',
    }),
    signal: terminalSignal({ attemptId: 'attempt-1' }),
    feedback: { verdict: 'pass', issues: [] },
    reviewedPackage: undefined,
  });

  assert.equal(review, null);
});

test('buildRecoveredReview rejects stale completed runtime context without a terminal signal', () => {
  const run = makeRun({ engineState: { publishGate: { reviews: [] } } });
  const review = buildRecoveredReview({
    run,
    ctx: reviewerContext({
      status: 'complete',
      attemptStartedAt: '2026-07-16T11:00:00.000Z',
      completedAt: '2026-07-16T10:40:00.000Z',
    }),
    signal: undefined,
    feedback: { verdict: 'pass', issues: [] },
    reviewedPackage: undefined,
  });

  assert.equal(review, null);
});

test('buildRecoveredReview ingests a completed ISSUES review as an extra review', () => {
  const run = makeRun({
    engineState: { publishGate: { reviews: [] } },
    metrics: {
      nudgeCount: 0,
      model: 'opus',
      runner: 'claude',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
  });
  const ctx = reviewerContext({ runner: 'codex', effort: 'low' });
  const review = buildRecoveredReview({
    run,
    ctx,
    signal: terminalSignal({ status: 'complete' }),
    feedback: { verdict: 'issues', issues: [{ file: 'a.ts', line: 3, description: 'bug' }] },
    reviewedPackage: undefined,
  });

  assert.ok(review);
  assert.equal(review.id, 'review-1');
  assert.equal(review.source, 'human-gate');
  assert.equal(review.verdict, 'issues');
  assert.equal(review.unresolvedCount, 1);
  assert.equal(review.loopNumber, 1);
  assert.equal(review.effort, 'low');
  // Reviewer runner differs from the worker runner → cross-runner review.
  // Unstamped: no package supplied, so it certifies nothing.
  assert.equal(review.reviewedHeadSha ?? null, null);
});

test('buildRecoveredReview preserves the dispatch source for automatic review plans', () => {
  const run = makeRun({
    engineState: {
      publishGate: {
        reviews: [],
        reviewPolicy: {
          minimumReviews: 1,
          requestedBy: 'dispatch',
        },
      },
    },
  });
  const review = buildRecoveredReview({
    run,
    ctx: reviewerContext(),
    signal: terminalSignal(),
    feedback: { verdict: 'pass', issues: [] },
    reviewedPackage: undefined,
  });

  assert.ok(review);
  assert.equal(review.source, 'dispatch');
});

test('buildRecoveredReview stamps a PASS review against the matching package and numbers after priors', () => {
  const pkg = makeReadyGatePackage({ headSha: 'deadbeef', reviewSubjectHash: 'subject-xyz' });
  const run = makeRun({
    engineState: {
      publishGate: {
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-1',
            reviewedHeadSha: 'fixture-head',
            mode: 'cold' as const,
            id: 'review-1',
            source: 'human-gate',
            loopNumber: 1,
            verdict: 'issues',
            unresolvedCount: 1,
          },
        ],
      },
    },
  });
  const ctx = reviewerContext({ runner: 'codex', model: 'gpt-5.5' });
  const review = buildRecoveredReview({
    run,
    ctx,
    signal: terminalSignal(),
    feedback: { verdict: 'pass', issues: [] },
    reviewedPackage: pkg,
  });

  assert.ok(review);
  // Numbered after the existing review.
  assert.equal(review.id, 'review-2');
  assert.equal(review.loopNumber, 2);
  assert.equal(review.verdict, 'pass');
  assert.equal(review.unresolvedCount, 0);
  // Stamped against the prepared package so the recovered PASS certifies it.
  assert.equal(review.reviewedHeadSha, 'deadbeef');
  assert.equal(review.reviewedReviewSubjectHash, 'subject-xyz');
});

test('buildRecoveredReview preserves a captured snapshot when the prepared package drifted', () => {
  const run = makeRun({ engineState: { publishGate: { reviews: [] } } });
  const review = buildRecoveredReview({
    run,
    ctx: reviewerContext(),
    signal: terminalSignal(),
    feedback: { verdict: 'pass', issues: [] },
    reviewSnapshot: {
      source: 'local-git',
      baseRef: 'main',
      baseSha: '1111111',
      headRef: 'fix/recovered-review',
      headSha: 'deadbeef',
      diffPath: 'artifacts/review-1/review-loop-1/review.diff',
      diffHash: 'a'.repeat(64),
      diffStat: { files: 1, additions: 2, deletions: 0 },
      capturedAt: '2026-07-16T10:01:00.000Z',
    },
    reviewedPackage: undefined,
  });

  assert.ok(review);
  assert.equal(review.reviewSnapshot?.headSha, 'deadbeef');
  assert.equal(review.reviewedHeadSha, 'deadbeef');
  assert.equal(review.reviewedReviewSubjectHash ?? null, null);
});

test('a failed or blocked reviewer never stamps a verdict, even with parseable PASS feedback', () => {
  const run = makeRun({ engineState: { publishGate: { reviews: [] } } });
  const ctx = reviewerContext();
  const feedback = { verdict: 'pass' as const, issues: [] };
  for (const status of ['failed', 'blocked'] as const) {
    const review = buildRecoveredReview({
      run,
      ctx,
      signal: terminalSignal({ status }),
      feedback,
      reviewedPackage: undefined,
    });
    assert.equal(review, null, `${status} signal must not certify a review`);
  }
});

test('freshness anchors on the current attempt launch, defeating warm-context reuse', () => {
  const run = makeRun({ engineState: { publishGate: { reviews: [] } } });
  // Warm-reused context: startedAt is loop 1's launch, attemptStartedAt is
  // loop 2's. A loop-1 signal written between them must be rejected.
  const ctx = reviewerContext({
    startedAt: '2026-07-16T10:00:00.000Z',
    attemptStartedAt: '2026-07-16T11:00:00.000Z',
  });
  const staleLoop1Signal = terminalSignal({ timestamp: '2026-07-16T10:40:00.000Z' });
  assert.equal(
    buildRecoveredReview({
      run,
      ctx,
      signal: staleLoop1Signal,
      feedback: { verdict: 'pass' as const, issues: [] },
      reviewedPackage: undefined,
    }),
    null,
  );
  // A signal after the relaunch is genuinely this pass's result.
  const freshSignal = terminalSignal({ timestamp: '2026-07-16T11:30:00.000Z' });
  assert.notEqual(
    buildRecoveredReview({
      run,
      ctx,
      signal: freshSignal,
      feedback: { verdict: 'pass' as const, issues: [] },
      reviewedPackage: undefined,
    }),
    null,
  );
});

test('startup reconciliation rewriting updatedAt does not reject the genuine pre-restart signal', () => {
  const run = makeRun({ engineState: { publishGate: { reviews: [] } } });
  // Restart ordering: the reviewer signaled complete BEFORE the crash; startup
  // reconciliation then rewrote updatedAt to the restart time BEFORE recovery
  // ran. The signal predates updatedAt but postdates the attempt launch — it
  // must still be ingested.
  const ctx = reviewerContext({
    startedAt: '2026-07-16T10:00:00.000Z',
    attemptStartedAt: '2026-07-16T10:00:00.000Z',
    updatedAt: '2026-07-16T12:00:00.000Z',
  });
  const preRestartSignal = terminalSignal({ timestamp: '2026-07-16T10:40:00.000Z' });
  assert.notEqual(
    buildRecoveredReview({
      run,
      ctx,
      signal: preRestartSignal,
      feedback: { verdict: 'pass' as const, issues: [] },
      reviewedPackage: undefined,
    }),
    null,
  );
});

test('appendRecoveredContinuationAttempt keeps an exhausted review instead of wiping the cap', () => {
  const existing: ReviewStatus = {
    reviewerSessionId: 'fixture-session-' + 'review-3',
    reviewedHeadSha: 'fixture-head',
    mode: 'cold' as const,
    id: 'review-3',
    source: 'human-gate',
    loopNumber: 3,
    verdict: 'issues',
    unresolvedCount: 6,
    feedbackSent: false,
    recoveryContinuationPending: true,
    retryCount: 3,
    maxRetries: 3,
    maxRetriesExhausted: true,
    issues: [{ file: 'a.ts', description: 'still broken' }],
    attempts: [
      { mode: 'cold' as const, loopNumber: 1, verdict: 'issues', unresolvedCount: 4 },
      { mode: 'cold' as const, loopNumber: 2, verdict: 'issues', unresolvedCount: 9 },
      { mode: 'cold' as const, loopNumber: 3, verdict: 'issues', unresolvedCount: 8 },
      { mode: 'cold' as const, loopNumber: 4, verdict: 'issues', unresolvedCount: 6 },
    ],
  };
  const recovered: ReviewStatus = {
    reviewerSessionId: 'fixture-session-' + 'review-3',
    reviewedHeadSha: 'fixture-head',
    mode: 'cold' as const,
    id: 'review-3',
    source: 'human-gate',
    loopNumber: 1,
    verdict: 'issues',
    unresolvedCount: 6,
    retryCount: 0,
    issues: [{ file: 'a.ts', description: 'still broken' }],
    attempts: [{ mode: 'cold' as const, loopNumber: 1, verdict: 'issues', unresolvedCount: 6 }],
  };
  const merged = appendRecoveredContinuationAttempt(existing, recovered);
  assert.equal(merged.retryCount, 3);
  assert.equal(merged.maxRetries, 3);
  assert.equal(merged.maxRetriesExhausted, true);
  assert.equal(merged.recoveryContinuationPending, false);
  assert.equal(merged.attempts?.length, 4);
  assert.equal(merged.unresolvedCount, 6);
});

test('TAT-4006: a reviewer lost to a host outage settles no-verdict, so five admissions use 4/5', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'lost-reviewer-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const vars = makeVars({ remoteRepo: repo, repo });
  const owner: Principal = {
    id: 'tat-4006-owner',
    subject: { type: 'person', displayName: 'Owner' },
    roles: [{ role: 'admin', scope: { kind: 'global' } }],
  };
  const previousOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;
  t.after(() => {
    if (previousOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previousOwner;
  });
  const run = runWithSessionOriginator(owner, () =>
    createRun({
      flowType: 'dev',
      project: 'example-mobile-farm',
      ticketOrPr: 'TAT-4006',
      runner: 'claude',
      slotId: vars.slotId,
      transport: 'native',
    }),
  );
  t.after(() => deleteTestRunIfPresent(run.id));
  const lost: AgentContext = {
    id: 'reviewer-1312',
    role: 'review',
    label: 'Reviewer',
    status: 'working',
    runId: run.id,
    slotId: vars.slotId,
    runner: 'claude',
    model: 'opus',
    reviewId: 'review-4',
    artifactScope: 'review-4',
    reviewLoopNumber: 1,
    startedAt: '2026-10-18T13:12:00.000Z',
    attemptStartedAt: '2026-10-18T13:12:04.000Z',
    updatedAt: '2026-10-18T13:12:04.000Z',
    // The host lost the reviewer process: its session is closed, nothing to reattach.
    nativeSession: {
      sessionId: 'reviewer-session',
      executionNodeId: 'outage-host',
      ownerPrincipalId: owner.id,
      leaseId: 'lease',
      commandId: 'review-command',
      closedAt: '2026-10-18T13:40:00.000Z',
    },
  };
  const lostRound = reviewRoundAdmissionId('review-4', 1, lost.startedAt!);
  for (const round of ['round-1', 'round-2', 'round-3', lostRound, 'round-5'])
    await admitReviewRound(run.id, round);
  updateRun(run.id, { agentContexts: [lost] });
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 5);

  await recoverInflightPublicationReviews(run.id, vars.slotId, {
    readers: {
      slot: async () => vars,
      config: async () => ({ enabled: true }),
      package: async () => undefined,
    },
  });

  assert.equal(getRun(run.id)!.agentContexts?.[0]?.status, 'failed');
  assert.equal(getRun(run.id)!.reviewRoundSettlements?.[lostRound]?.reason, 'lost on restart');
  const budget = await runReviewRoundBudget(getRun(run.id)!);
  assert.equal(reviewRoundBudgetLabel(budget), 'Review rounds 4/5 · 1/3 no-verdict');
});
