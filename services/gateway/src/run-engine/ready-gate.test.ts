import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ExecResult,
  IndependentReviewStatus,
  PublicationReviewLaunchRejection,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { createRun, getRun, updateRun, updateRunStep } from '../runs/store.js';

import {
  executePublishGateReviewPlan,
  localVideoProofWarning,
  resumeInterruptedPublicationReview,
} from './ready-gate.js';
import {
  assertIndependentReviewLaunchState,
  publicationReviewLaunchRejectionFromError,
} from './review-launch-gate.js';
import { deleteTestRunIfPresent } from './test-fixtures.js';

function gitExecutor(status: string, headSha: string): (command: string) => Promise<ExecResult> {
  return async (command) => {
    if (command.includes('status --porcelain')) {
      return { stdout: status, stderr: '', exitCode: 0 };
    }
    if (command.includes('rev-parse HEAD')) {
      return { stdout: `${headSha}\n`, stderr: '', exitCode: 0 };
    }
    throw new Error(`Unexpected git probe: ${command}`);
  };
}

function issuesReview(reviewedHeadSha: string): IndependentReviewStatus {
  return {
    id: 'extra-review-1',
    source: 'human-gate',
    crossRunner: true,
    loopNumber: 1,
    verdict: 'issues',
    unresolvedCount: 1,
    reviewedHeadSha,
    artifactPaths: [
      'artifacts/extra-review-loop-1/review.diff',
      'artifacts/extra-review-loop-1/self-review.md',
    ],
  };
}

test('localVideoProofWarning flags screenshot packages without local video proof', () => {
  assert.match(
    localVideoProofWarning([{ path: 'artifacts/recipe-run/after.png' }]) ?? '',
    /Local video proof missing/,
  );
  assert.equal(
    localVideoProofWarning([
      { path: 'artifacts/recipe-run/after.png' },
      { path: 'artifacts/after.mp4' },
    ]),
    null,
  );
  assert.equal(localVideoProofWarning([{ path: 'artifacts/report.md' }]), null);
});

test('resumeInterruptedPublicationReview continues the same issues review instead of launching another', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-RECOVER-REVIEW',
    runner: 'codex',
  });
  t.after(async () => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
    slotId: 'slot-1',
    engineState: {
      publishGate: {
        independentReviews: [
          {
            id: 'independent-review-1',
            source: 'dispatch',
            runner: 'codex',
            model: 'gpt-5.6-sol',
            crossRunner: false,
            loopNumber: 1,
            verdict: 'issues',
            unresolvedCount: 1,
            issues: [{ file: 'src/example.ts', line: 4, description: 'Fix this issue' }],
            validationDepth: 'static-code',
            feedbackSent: false,
            recoveryContinuationPending: true,
            attempts: [
              {
                loopNumber: 1,
                verdict: 'issues',
                unresolvedCount: 1,
                issues: [{ file: 'src/example.ts', line: 4, description: 'Fix this issue' }],
                validationDepth: 'static-code',
              },
            ],
          },
        ],
      },
    },
  });

  let executions = 0;
  const resume = () =>
    resumeInterruptedPublicationReview(run.id, 'slot-1', {
      executeReview: async (_runId, _slotId, options) => {
        executions += 1;
        assert.ok(options);
        assert.equal(options.artifactScope, 'independent-review-1');
        assert.equal(options.resumeFromResult?.verdict, 'issues');
        assert.equal(options.resumeFromResult?.issues?.length, 1);
        return {
          verdict: 'pass',
          issues: [],
          retryCount: 1,
          feedbackSent: true,
          validationDepth: 'static-code',
          attempts: [
            {
              loopNumber: 2,
              verdict: 'pass',
              unresolvedCount: 0,
              validationDepth: 'static-code',
            },
          ],
        };
      },
    });
  const [resumed, concurrent] = await Promise.all([resume(), resume()]);

  assert.deepEqual(resumed, { reviewId: 'independent-review-1', verdict: 'pass' });
  assert.deepEqual(concurrent, resumed);
  assert.equal(executions, 1);
  const reviews = getRun(run.id)?.engineState?.publishGate?.independentReviews ?? [];
  assert.equal(reviews.length, 1, 'recovery must replace the interrupted review in place');
  assert.equal(reviews[0]?.id, 'independent-review-1');
  assert.equal(reviews[0]?.verdict, 'pass');
  assert.equal(reviews[0]?.feedbackSent, true);
});

test('resumeInterruptedPublicationReview keeps feedback recoverable when delivery fails', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-RECOVER-DELIVERY',
    runner: 'codex',
  });
  t.after(async () => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
    slotId: 'slot-1',
    engineState: {
      publishGate: {
        independentReviews: [
          {
            id: 'independent-review-1',
            source: 'dispatch',
            runner: 'codex',
            crossRunner: false,
            loopNumber: 1,
            verdict: 'issues',
            unresolvedCount: 1,
            issues: [{ file: 'src/example.ts', description: 'Fix this issue' }],
            feedbackSent: false,
            recoveryContinuationPending: true,
          },
        ],
      },
    },
  });

  assert.equal(
    await resumeInterruptedPublicationReview(run.id, 'slot-1', {
      executeReview: async () => {
        throw new Error('delivery failed');
      },
    }),
    null,
  );
  assert.equal(
    getRun(run.id)?.engineState?.publishGate?.independentReviews?.[0]?.feedbackSent,
    false,
  );
});

test('independent publication review refuses a dirty slot with a commit action', async () => {
  await assert.rejects(
    assertIndependentReviewLaunchState(
      [],
      gitExecutor(' M services/gateway/src/run-engine/ready-gate.ts\n?? scratch.txt\n', 'abc123'),
    ),
    (error: unknown) => {
      const envelope = error as {
        code?: string;
        message?: string;
        userAction?: string;
        details?: { dirtyPathCount?: number };
      };
      assert.equal(envelope.code, 'PUBLICATION_REVIEW_LAUNCH_REJECTED');
      assert.match(envelope.message ?? '', /dirty tree.*2 uncommitted path/iu);
      assert.match(envelope.userAction ?? '', /git status.*git commit/iu);
      assert.equal(envelope.details?.dirtyPathCount, 2);
      return true;
    },
  );
});

test('independent publication re-review refuses the same HEAD after issues', async () => {
  await assert.rejects(
    assertIndependentReviewLaunchState([issuesReview('abc123')], gitExecutor('', 'abc123')),
    (error: unknown) => {
      const envelope = error as {
        code?: string;
        message?: string;
        userAction?: string;
        details?: { priorReviewCommit?: string; priorFeedbackPath?: string };
      };
      assert.equal(envelope.code, 'PUBLICATION_REVIEW_LAUNCH_REJECTED');
      assert.match(envelope.message ?? '', /prior issues review.*abc123/iu);
      assert.match(envelope.message ?? '', /extra-review-loop-1\/self-review\.md/u);
      assert.match(envelope.userAction ?? '', /fix.*git commit.*new HEAD/iu);
      assert.equal(envelope.details?.priorReviewCommit, 'abc123');
      assert.ok(envelope.details?.priorFeedbackPath);
      return true;
    },
  );
});

test('independent publication re-review allows a clean advanced HEAD', async () => {
  assert.deepEqual(
    await assertIndependentReviewLaunchState([issuesReview('abc123')], gitExecutor('', 'def456')),
    { dirtyPathCount: 0, headSha: 'def456' },
  );
});

test('independent publication review surfaces a recoverable non-zero git probe failure', async () => {
  await assert.rejects(
    assertIndependentReviewLaunchState([], async (command) => ({
      stdout: '',
      stderr: command.includes('status --porcelain') ? 'not a git worktree' : '',
      exitCode: command.includes('status --porcelain') ? 128 : 0,
    })),
    (error: unknown) => {
      const rejection = publicationReviewLaunchRejectionFromError(error);
      assert.equal(rejection?.code, 'PUBLICATION_REVIEW_GIT_PROBE_FAILED');
      assert.match(rejection?.message ?? '', /git status failed \(exit 128\)/u);
      assert.match(rejection?.userAction ?? '', /git status.*git rev-parse HEAD/iu);
      return true;
    },
  );
});

test('independent publication review surfaces a recoverable empty HEAD probe failure', async () => {
  await assert.rejects(
    assertIndependentReviewLaunchState([], gitExecutor('', '')),
    (error: unknown) => {
      const rejection = publicationReviewLaunchRejectionFromError(error);
      assert.equal(rejection?.code, 'PUBLICATION_REVIEW_GIT_PROBE_FAILED');
      assert.match(rejection?.message ?? '', /returned no commit/u);
      assert.match(rejection?.userAction ?? '', /valid commit.*git rev-parse HEAD/iu);
      return true;
    },
  );
});

test('empty publish-gate review plans clear a prior recoverable rejection', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-REVIEW-EMPTY-PLAN',
    runner: 'claude',
    slotId: 'test-review-empty-plan-slot',
    engineState: {
      publishGate: {
        reviewLaunchRejection: {
          code: 'PUBLICATION_REVIEW_LAUNCH_REJECTED',
          message: 'A prior launch was refused.',
          userAction: 'Commit fixes.',
          rejectedAt: '2026-08-03T00:00:00.000Z',
        },
      },
    },
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  assert.deepEqual(
    await executePublishGateReviewPlan(run.id, 'test-review-empty-plan-slot', [], 'human-gate'),
    { reviewIds: [] },
  );
  assert.equal(getRun(run.id)?.engineState?.publishGate?.reviewLaunchRejection, undefined);
});

test('publish-gate review orchestration preserves a recoverable gate and launches no reviewer when refused', async (t) => {
  const pendingPlan = [{ order: 1, runner: 'codex' as const }];
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-REVIEW-LAUNCH-REFUSAL',
    runner: 'claude',
    slotId: 'test-review-launch-slot',
    engineState: {
      publishGate: {
        pendingReviewPlan: pendingPlan,
        pendingReviewPlanRequestedAt: '2026-08-03T00:00:00.000Z',
      },
    },
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  let reviewerLaunches = 0;
  const result = await executePublishGateReviewPlan(
    run.id,
    'test-review-launch-slot',
    pendingPlan,
    'human-gate',
    {
      assertLaunchAllowed: async () => {
        const latest = getRun(run.id)!;
        updateRun(run.id, {
          engineState: {
            ...latest.engineState,
            publishGate: {
              ...latest.engineState?.publishGate,
              feedbackArtifactPath: 'artifacts/concurrent-feedback.md',
            },
          },
        });
        updateRunStep(run.id, 'human-gate', {
          outputs: { concurrentMarker: true },
        });
        throw new GatewayMethodError(
          'PUBLICATION_REVIEW_LAUNCH_REJECTED',
          'Independent review launch refused: test worktree is dirty.',
          {
            userAction: 'Commit the validated fixes, then request re-review.',
            details: { dirtyPathCount: 1 },
          },
        );
      },
      executeReview: async () => {
        reviewerLaunches += 1;
        throw new Error('reviewer must not launch');
      },
    },
  );

  assert.equal(reviewerLaunches, 0);
  assert.equal(result.reviewIds.length, 0);
  assert.equal(result.rejection?.code, 'PUBLICATION_REVIEW_LAUNCH_REJECTED');
  assert.equal(result.rejection?.userAction, 'Commit the validated fixes, then request re-review.');
  const persisted = getRun(run.id)!;
  assert.deepEqual(persisted.engineState?.publishGate?.pendingReviewPlan, pendingPlan);
  assert.equal(
    persisted.engineState?.publishGate?.feedbackArtifactPath,
    'artifacts/concurrent-feedback.md',
  );
  assert.equal(
    persisted.engineState?.publishGate?.reviewLaunchRejection?.userAction,
    'Commit the validated fixes, then request re-review.',
  );
  const humanGateStep = persisted.steps.find((step) => step.name === 'human-gate');
  assert.equal(humanGateStep?.status, 'pending');
  assert.equal(humanGateStep?.outputs?.concurrentMarker, true);
  assert.equal(
    (humanGateStep?.outputs?.reviewLaunchRejection as PublicationReviewLaunchRejection | undefined)
      ?.userAction,
    'Commit the validated fixes, then request re-review.',
  );
});
