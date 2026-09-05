import assert from 'node:assert/strict';
import test from 'node:test';

import type { PublicationReviewLaunchRejection, Run } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { createRun, getRun, updateRun, updateRunStep } from '../runs/store.js';
import { TerminalReviewArtifactError } from '../self-review/terminal-result.js';

import { BlockedRunError } from './errors.js';
import {
  executePublishGateReviewPlan,
  freedSlotGateResolutionBlocker,
  localVideoProofWarning,
  reconcileReviewLaunchRejectionForCurrentHead,
  resumeInterruptedPublicationReview,
} from './ready-gate.js';
import { deleteTestRunIfPresent, makeRun } from './test-fixtures.js';

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
  await assert.rejects(
    resumeInterruptedPublicationReview(run.id, 'slot-1', {
      executeReview: async () => {
        throw new TerminalReviewArtifactError('structured reviewer result is invalid');
      },
    }),
    TerminalReviewArtifactError,
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

test('ready-gate rejection is retained at the same HEAD and cleared after HEAD drift', async (t) => {
  const rejection: PublicationReviewLaunchRejection = {
    code: 'PUBLICATION_REVIEW_LAUNCH_REJECTED',
    message: 'A prior review launch was refused.',
    userAction: 'Commit fixes.',
    details: { currentHeadSha: 'aaaaaaaa' },
    rejectedAt: '2026-08-03T00:00:00.000Z',
  };
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-REVIEW-HEAD-DRIFT',
    runner: 'claude',
    slotId: 'test-review-head-drift-slot',
    engineState: { publishGate: { reviewLaunchRejection: rejection } },
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  const sameHeadPayloadRejection = reconcileReviewLaunchRejectionForCurrentHead(run.id, 'aaaaaaaa');
  assert.deepEqual(sameHeadPayloadRejection, rejection);
  assert.deepEqual(getRun(run.id)?.engineState?.publishGate?.reviewLaunchRejection, rejection);

  const advancedHeadPayloadRejection = reconcileReviewLaunchRejectionForCurrentHead(
    run.id,
    'bbbbbbbb',
  );
  assert.equal(advancedHeadPayloadRejection, undefined);
  assert.equal(getRun(run.id)?.engineState?.publishGate?.reviewLaunchRejection, undefined);
});

test('ready-gate clears a recovered git-probe rejection after a successful HEAD capture', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-REVIEW-PROBE-RECOVERED',
    runner: 'claude',
    engineState: {
      publishGate: {
        reviewLaunchRejection: {
          code: 'PUBLICATION_REVIEW_GIT_PROBE_FAILED',
          message: 'The node was disconnected.',
          userAction: 'Restore the node connection.',
          rejectedAt: '2026-08-03T00:00:00.000Z',
        },
      },
    },
  });
  t.after(async () => deleteTestRunIfPresent(run.id));

  assert.equal(
    reconcileReviewLaunchRejectionForCurrentHead(run.id, undefined)?.code,
    'PUBLICATION_REVIEW_GIT_PROBE_FAILED',
  );
  assert.equal(reconcileReviewLaunchRejectionForCurrentHead(run.id, 'bbbbbbbb'), undefined);
  assert.equal(getRun(run.id)?.engineState?.publishGate?.reviewLaunchRejection, undefined);
});

test('ready-gate retains a git-probe rejection at its captured HEAD and clears it after drift', async (t) => {
  const rejection: PublicationReviewLaunchRejection = {
    code: 'PUBLICATION_REVIEW_GIT_PROBE_FAILED',
    message: 'Git status failed.',
    userAction: 'Repair the worktree.',
    details: { currentHeadSha: 'aaaaaaaa' },
    rejectedAt: '2026-08-03T00:00:00.000Z',
  };
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-REVIEW-PROBE-HEAD-DRIFT',
    runner: 'claude',
    engineState: { publishGate: { reviewLaunchRejection: rejection } },
  });
  t.after(async () => deleteTestRunIfPresent(run.id));

  assert.deepEqual(reconcileReviewLaunchRejectionForCurrentHead(run.id, 'aaaaaaaa'), rejection);
  assert.equal(reconcileReviewLaunchRejectionForCurrentHead(run.id, 'bbbbbbbb'), undefined);
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

test('a resolved publication gate fails closed when the run park freed its slot', () => {
  const base = makeRun({ id: 'run-gate-parked', flowType: 'dev', mode: 'autonomous' });
  assert.equal(freedSlotGateResolutionBlocker(base), null);

  const parked: Run = {
    ...base,
    park: {
      version: 1,
      operationId: 'park-1',
      previewId: 'preview-1',
      runId: base.id,
      generation: 1,
      machine: 'machine-a',
      slotId: base.slotId!,
      mode: 'release',
      phase: 'parked',
      slotDisposition: 'freed',
      slotFreedAt: '2026-09-05T00:00:10.000Z',
      prePauseStatus: 'human-gating',
      prePauseCurrentStep: { index: 1, name: 'human-gate', status: 'running' },
      resourceManifest: {
        capturedAt: '2026-09-05T00:00:00.000Z',
        resources: [],
        capabilityLeases: [],
      },
      recoveryHandle: null,
      errors: [],
      residuals: { runner: 'stopped', resources: [] },
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:10.000Z',
    },
  };
  const blocker = freedSlotGateResolutionBlocker(parked);
  // BlockedRunError so the engine marks the run `blocked`, not `failed`: cancel
  // refuses terminal runs, and a failed run would strand the park record.
  assert.ok(blocker instanceof BlockedRunError);
  assert.match(blocker.message, /FREED_SLOT_RESTORE_UNSUPPORTED/);
  assert.match(blocker.message, /cancel the run/);

  // The fence covers the park BEFORE `slotFreedAt` lands too: while resources
  // are stopping, resolving the gate would publish against a worker being
  // stopped underneath it.
  const stopping: Run = {
    ...parked,
    park: { ...parked.park!, phase: 'resources-stopping', slotFreedAt: undefined },
  };
  assert.match(
    freedSlotGateResolutionBlocker(stopping)?.message ?? '',
    /GATE_PARK_IN_FLIGHT/,
    'an in-flight gate park blocks gate resolution',
  );

  // A settled record does not block: restore and cancel both clear the fence.
  for (const phase of ['restored', 'cancelled'] as const) {
    assert.equal(
      freedSlotGateResolutionBlocker({ ...parked, park: { ...parked.park!, phase } }),
      null,
      `a ${phase} record must not block the gate`,
    );
  }
});
