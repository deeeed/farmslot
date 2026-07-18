import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext, WorkerSignal } from '@farmslot/protocol';

import { buildRecoveredReview, isRecoverableReviewerContext } from './recover-inflight-reviews.js';
import { makeReadyGatePackage, makeRun } from './test-fixtures.js';

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

test('isRecoverableReviewerContext accepts only in-flight self-review contexts', () => {
  assert.equal(isRecoverableReviewerContext({ role: 'self-review', status: 'working' }), true);
  assert.equal(isRecoverableReviewerContext({ role: 'self-review', status: 'launching' }), true);
  // Normal completion / failure already reconciled the context — never re-ingest.
  assert.equal(isRecoverableReviewerContext({ role: 'self-review', status: 'complete' }), false);
  assert.equal(isRecoverableReviewerContext({ role: 'self-review', status: 'failed' }), false);
  // Other roles never produce a publish-gate independent review.
  assert.equal(isRecoverableReviewerContext({ role: 'primary', status: 'working' }), false);
  assert.equal(isRecoverableReviewerContext({ role: 'self-review-fix', status: 'working' }), false);
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
