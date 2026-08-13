import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext, IndependentReviewStatus, WorkerSignal } from '@farmslot/protocol';

import { createRun, getRun, updateRun } from '../runs/store.js';

import {
  buildRecoveredReview,
  isRecoverableReviewerContext,
  normalizeExhaustedReviewContinuationsForRun,
  recoveredReviewAlreadyIngested,
  recoveredReviewArtifactScope,
  reviewerContextIsSettled,
  reviewerContextNeedsRecovery,
} from './recover-inflight-reviews.js';
import { deleteTestRunIfPresent, makeReadyGatePackage, makeRun } from './test-fixtures.js';

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

  const exhausted: IndependentReviewStatus = {
    id: 'extra-review-1',
    source: 'human-gate',
    crossRunner: false,
    loopNumber: 1,
    verdict: 'issues',
    unresolvedCount: 1,
    issues: [{ file: 'a.ts', description: 'unresolved' }],
    feedbackSent: true,
    attempts: [{ loopNumber: 1, verdict: 'issues', unresolvedCount: 1 }],
  };
  updateRun(run.id, { engineState: { publishGate: { independentReviews: [exhausted] } } });

  const normalized = normalizeExhaustedReviewContinuationsForRun(run.id);
  assert.equal(normalized[0].feedbackSent, false);
  assert.equal(normalized[0].recoveryContinuationPending, true);
  assert.deepEqual(getRun(run.id)?.engineState?.publishGate?.independentReviews, normalized);

  // Idempotent: the second entry point over already-normalized reviews returns
  // the stored array untouched rather than rewriting it.
  const second = normalizeExhaustedReviewContinuationsForRun(run.id);
  assert.equal(second, getRun(run.id)?.engineState?.publishGate?.independentReviews);
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

test('recovery deduplicates one review generation even when its terminal signal is later', () => {
  const attempt = {
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
    role: overrides.role ?? 'self-review',
    label: overrides.label ?? 'Reviewer',
    status: overrides.status ?? 'working',
    slotId: overrides.slotId ?? 'slot-1',
    runId: overrides.runId ?? 'run-1',
    taskFile: 'taskFile' in overrides ? overrides.taskFile : 'tasks/PROJ-1/SELF-REVIEW.rev-abc.md',
    signalFile:
      'signalFile' in overrides
        ? overrides.signalFile
        : 'tasks/PROJ-1/SELF-REVIEW.rev-abc-SIGNAL.json',
    runner: overrides.runner ?? 'codex',
    model: overrides.model ?? 'gpt-5.5',
    startedAt: overrides.startedAt ?? '2026-07-16T10:00:00.000Z',
    ...overrides,
  };
}

function terminalSignal(overrides: Partial<WorkerSignal> = {}): WorkerSignal {
  return {
    role: 'self-review',
    status: overrides.status ?? 'complete',
    outcome: overrides.outcome,
    timestamp: overrides.timestamp ?? '2026-07-16T10:40:00.000Z',
    ...overrides,
  };
}

test('isRecoverableReviewerContext keeps failed reviewers out of the long-lived watcher', () => {
  assert.equal(isRecoverableReviewerContext({ role: 'self-review', status: 'working' }), true);
  assert.equal(isRecoverableReviewerContext({ role: 'self-review', status: 'launching' }), true);
  assert.equal(isRecoverableReviewerContext({ role: 'self-review', status: 'complete' }), true);
  assert.equal(isRecoverableReviewerContext({ role: 'self-review', status: 'failed' }), false);
  assert.equal(
    isRecoverableReviewerContext(
      { role: 'self-review', status: 'failed' },
      { includeFailed: true },
    ),
    true,
  );
  // Other roles never produce a publish-gate independent review.
  assert.equal(isRecoverableReviewerContext({ role: 'primary', status: 'working' }), false);
  assert.equal(isRecoverableReviewerContext({ role: 'self-review-fix', status: 'working' }), false);
});

test('reviewerContextNeedsRecovery deduplicates completed contexts by artifact scope', () => {
  const complete = reviewerContext({
    status: 'complete',
    artifactScope: 'independent-review-7',
  });
  assert.equal(reviewerContextNeedsRecovery(complete, []), true);
  assert.equal(reviewerContextNeedsRecovery(complete, [{ id: 'independent-review-7' }]), false);
  assert.equal(
    reviewerContextNeedsRecovery(complete, [
      {
        id: 'independent-review-7',
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
        id: 'independent-review-7',
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
        id: 'independent-review-7',
        source: 'dispatch',
        verdict: 'issues',
        unresolvedCount: 1,
        feedbackSent: false,
        recoveryContinuationPending: true,
        issues: [{ file: 'src/example.ts', description: 'Fix this issue' }],
      },
      {
        id: 'independent-review-8',
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
        id: 'independent-review-7',
        source: 'human-gate',
        verdict: 'skipped',
        unresolvedCount: 0,
      },
      {
        id: 'independent-review-8',
        source: 'human-gate',
        verdict: 'skipped',
        unresolvedCount: 0,
      },
    ]),
    true,
    'a later skipped placeholder does not suppress an authoritative reviewer artifact',
  );
});

test('reviewerContextIsSettled terminalizes persisted and superseded reviewer ghosts', () => {
  const working = reviewerContext({
    status: 'working',
    artifactScope: 'independent-review-7',
  });
  assert.equal(
    reviewerContextIsSettled(working, [
      {
        id: 'independent-review-7',
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
        id: 'independent-review-7',
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
        id: 'independent-review-7',
        source: 'dispatch',
        verdict: 'issues',
        unresolvedCount: 1,
        feedbackSent: false,
        recoveryContinuationPending: true,
        issues: [{ file: 'src/example.ts', description: 'Fix this issue' }],
      },
      {
        id: 'independent-review-8',
        source: 'dispatch',
        verdict: 'pass',
        unresolvedCount: 0,
      },
    ]),
    true,
    'a later persisted review supersedes an older pending continuation',
  );
  assert.equal(
    reviewerContextIsSettled(
      reviewerContext({ status: 'complete', artifactScope: 'independent-review-7' }),
      [{ id: 'independent-review-7', verdict: 'pass', unresolvedCount: 0 }],
    ),
    false,
  );
});

test('a one-shot scan only replaces an explicitly recoverable failed placeholder', () => {
  const failed = reviewerContext({
    status: 'failed',
    artifactScope: 'independent-review-7',
  });
  assert.equal(
    reviewerContextNeedsRecovery(failed, [], { includeFailed: true }),
    false,
    'a failed reviewer without a delivery placeholder is terminal',
  );
  assert.equal(
    reviewerContextNeedsRecovery(failed, [
      {
        id: 'independent-review-7',
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
          id: 'independent-review-7',
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
          id: 'independent-review-7',
          source: 'dispatch',
          verdict: 'failed',
          unresolvedCount: 0,
          feedbackSent: false,
          recoveryContinuationPending: true,
        },
        {
          id: 'independent-review-8',
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
          id: 'independent-review-7',
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
          id: 'independent-review-7',
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
    run: makeRun({ engineState: { publishGate: { independentReviews: [] } } }),
    ctx: reviewerContext({
      status: 'failed',
      artifactScope: 'independent-review-7',
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
  assert.equal(review.id, 'independent-review-7');
  assert.equal(review.verdict, 'issues');
  assert.equal(review.unresolvedCount, 1);
});

test('restart recovery uses the reviewer-owned artifact scope instead of review-array length', () => {
  assert.equal(
    recoveredReviewArtifactScope({ artifactScope: 'independent-review-7' }, 'independent-review-2'),
    'independent-review-7',
  );
  assert.equal(recoveredReviewArtifactScope({}, 'independent-review-2'), 'independent-review-2');
});

test('buildRecoveredReview preserves the reviewer-owned artifact scope as the review id', () => {
  const review = buildRecoveredReview({
    run: makeRun({ engineState: { publishGate: { independentReviews: [] } } }),
    ctx: reviewerContext({ artifactScope: 'independent-review-7' }),
    signal: terminalSignal(),
    feedback: { verdict: 'pass', issues: [] },
    reviewedPackage: undefined,
  });

  assert.ok(review);
  assert.equal(review.id, 'independent-review-7');
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
  const run = makeRun({ engineState: { publishGate: { independentReviews: [] } } });
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
    run: makeRun({ engineState: { publishGate: { independentReviews: [] } } }),
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
    run: makeRun({ engineState: { publishGate: { independentReviews: [] } } }),
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
  const run = makeRun({ engineState: { publishGate: { independentReviews: [] } } });
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
    engineState: { publishGate: { independentReviews: [] } },
    metrics: {
      nudgeCount: 0,
      model: 'opus',
      runner: 'claude',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
  });
  const ctx = reviewerContext({ runner: 'codex' });
  const review = buildRecoveredReview({
    run,
    ctx,
    signal: terminalSignal({ status: 'complete' }),
    feedback: { verdict: 'issues', issues: [{ file: 'a.ts', line: 3, description: 'bug' }] },
    reviewedPackage: undefined,
  });

  assert.ok(review);
  assert.equal(review.id, 'independent-review-1');
  assert.equal(review.source, 'human-gate');
  assert.equal(review.verdict, 'issues');
  assert.equal(review.unresolvedCount, 1);
  assert.equal(review.loopNumber, 1);
  // Reviewer runner differs from the worker runner → cross-runner review.
  assert.equal(review.crossRunner, true);
  // Unstamped: no package supplied, so it certifies nothing.
  assert.equal(review.reviewedHeadSha ?? null, null);
});

test('buildRecoveredReview preserves the dispatch source for automatic review plans', () => {
  const run = makeRun({
    engineState: {
      publishGate: {
        independentReviews: [],
        reviewDepth: {
          minimumIndependentReviews: 1,
          requireCrossRunner: true,
          extraLoopsRequested: 0,
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
        independentReviews: [
          {
            id: 'independent-review-1',
            source: 'human-gate',
            crossRunner: false,
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
  assert.equal(review.id, 'independent-review-2');
  assert.equal(review.loopNumber, 2);
  assert.equal(review.verdict, 'pass');
  assert.equal(review.unresolvedCount, 0);
  // Stamped against the prepared package so the recovered PASS certifies it.
  assert.equal(review.reviewedHeadSha, 'deadbeef');
  assert.equal(review.reviewedReviewSubjectHash, 'subject-xyz');
});

test('buildRecoveredReview preserves a captured snapshot when the prepared package drifted', () => {
  const run = makeRun({ engineState: { publishGate: { independentReviews: [] } } });
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
      diffPath: 'artifacts/independent-review-1/review-loop-1/review.diff',
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
  const run = makeRun({ engineState: { publishGate: { independentReviews: [] } } });
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
  const run = makeRun({ engineState: { publishGate: { independentReviews: [] } } });
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
  const run = makeRun({ engineState: { publishGate: { independentReviews: [] } } });
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
