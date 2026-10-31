import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  Events,
  type PublicationReviewLaunchRejection,
  type ReviewRequestPayload,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';
import { ReviewDispatchViewModel } from '@farmslot/review-dispatch';

import { GatewayMethodError } from '../core/method-error.js';
import { admitReviewRound, settleReviewRoundNoVerdict } from '../review/review-round-budget.js';
import { TerminalReviewArtifactError } from '../review/terminal-result.js';
import type { RunProgressObservation } from '../runners/run-progress.js';
import { createRun, getAllRuns, getRun, updateRun, updateRunStep } from '../runs/store.js';

import { resolveEngineDecision, setEngineDecisionRuntime } from './engine-decisions.js';
import { BlockedRunError, OwnedWorkerBusyError } from './errors.js';
import {
  executePublishGateReviewPlan,
  executeReadyGate,
  freedSlotGateResolutionBlocker,
  localVideoProofWarning,
  type PublishGateReviewPlanDependencies,
  reconcileReviewLaunchRejectionForCurrentHead,
  resumeInterruptedPublicationReview,
} from './ready-gate.js';
import { reviewLineageOptionsForRun } from './review-plan.js';
import { deleteTestRunIfPresent, makeReadyGatePackage, makeRun } from './test-fixtures.js';

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

test('resumeInterruptedPublicationReview continues the same issues review WARM in its lineage', async (t) => {
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
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-1',
            reviewedHeadSha: 'fixture-head',
            reviewSnapshot: {
              source: 'local-git',
              baseSha: 'fixture-base',
              headSha: 'fixture-head',
              capturedAt: '2026-10-20T00:00:00Z',
            },
            mode: 'cold' as const,
            id: 'review-1',
            source: 'dispatch',
            runner: 'codex',
            model: 'gpt-5.6-sol',
            effort: 'low',
            loopNumber: 1,
            verdict: 'issues',
            unresolvedCount: 1,
            issues: [{ file: 'src/example.ts', line: 4, description: 'Fix this issue' }],
            validationDepth: 'static-code',
            feedbackSent: false,
            recoveryContinuationPending: true,
            attempts: [
              {
                mode: 'cold' as const,
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
        // ADR-063 Amendment 5: an unpublished COLD first pass is re-reviewed WARM in its lineage.
        assert.equal(options.mode, 'warm');
        assert.equal(options.reviewId, 'review-1');
        assert.equal(options.resumeFromResult?.reviewSnapshot?.headSha, 'fixture-head');
        assert.equal(options.artifactScope, 'review-1');
        assert.equal(options.effort, 'low');
        assert.equal(options.resumeFromResult?.verdict, 'issues');
        assert.equal(options.resumeFromResult?.issues?.length, 1);
        assert.equal(options.resumeFromResult?.effort, 'low');
        return {
          verdict: 'pass',
          issues: [],
          retryCount: 1,
          feedbackSent: true,
          validationDepth: 'static-code',
          attempts: [
            {
              mode: 'cold' as const,
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

  assert.deepEqual(resumed, { reviewId: 'review-1', verdict: 'pass' });
  assert.deepEqual(concurrent, resumed);
  assert.equal(executions, 1);
  const reviews = getRun(run.id)?.engineState?.publishGate?.reviews ?? [];
  assert.equal(reviews.length, 1, 'recovery must replace the interrupted review in place');
  assert.equal(reviews[0]?.id, 'review-1');
  assert.equal(reviews[0]?.verdict, 'pass');
  assert.equal(reviews[0]?.feedbackSent, true);
});

test('resumeInterruptedPublicationReview resumes a review recorded without depth as full-live', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-RECOVER-LEGACY-DEPTH',
    runner: 'codex',
  });
  t.after(async () => deleteTestRunIfPresent(run.id));
  const issues = [{ file: 'src/example.ts', line: 4, description: 'Fix this issue' }];
  updateRun(run.id, {
    slotId: 'slot-1',
    engineState: {
      publishGate: {
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-legacy',
            reviewedHeadSha: 'fixture-head',
            mode: 'cold' as const,
            id: 'review-legacy',
            source: 'dispatch',
            runner: 'codex',
            loopNumber: 1,
            verdict: 'issues',
            unresolvedCount: 1,
            issues,
            feedbackSent: false,
            recoveryContinuationPending: true,
            attempts: [
              {
                mode: 'cold' as const,
                loopNumber: 1,
                verdict: 'issues',
                unresolvedCount: 1,
                issues,
              },
            ],
          },
        ],
      },
    },
  });
  const depths: Array<string | null | undefined> = [];
  await resumeInterruptedPublicationReview(run.id, 'slot-1', {
    executeReview: async (_runId, _slotId, options) => {
      depths.push(options?.validationDepth);
      return { verdict: 'pass', issues: [], retryCount: 1, feedbackSent: true };
    },
  });
  assert.deepEqual(depths, ['full-live'], 'a pre-depth review keeps the live contract it ran');
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
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-1',
            reviewedHeadSha: 'fixture-head',
            mode: 'cold' as const,
            id: 'review-1',
            source: 'dispatch',
            runner: 'codex',
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
  assert.equal(getRun(run.id)?.engineState?.publishGate?.reviews?.[0]?.feedbackSent, false);
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
  const pendingPlan = [
    { runner: 'codex' as const, model: null, effort: null, mode: 'cold' as const },
  ];
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-REVIEW-LAUNCH-REFUSAL',
    runner: 'claude',
    slotId: 'test-review-launch-slot',
    engineState: {
      publishGate: {
        reviewSequence: pendingPlan,
        reviewSequenceRequestedAt: '2026-08-03T00:00:00.000Z',
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
          'Review launch refused: test worktree is dirty.',
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
  assert.deepEqual(persisted.engineState?.publishGate?.reviewSequence, pendingPlan);
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

test('at the no-verdict cap an automatic gate plan launches no reviewer; an operator request does', async (t) => {
  const plan = [{ runner: 'codex' as const, model: null, effort: null, mode: 'cold' as const }];
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-NO-VERDICT-CAP',
    runner: 'claude',
    slotId: 'test-no-verdict-cap-slot',
  });
  t.after(async () => deleteTestRunIfPresent(run.id));
  for (const reason of ['timeout', 'invalid JSON', 'lost on restart']) {
    await admitReviewRound(run.id, reason);
    await settleReviewRoundNoVerdict(run.id, reason, reason);
  }
  let reviewerLaunches = 0;
  const dependencies = {
    assertLaunchAllowed: async () => {},
    executeReview: async () => {
      reviewerLaunches += 1;
      return { verdict: 'pass' as const, issues: [], retryCount: 0 };
    },
  };

  const automatic = await executePublishGateReviewPlan(
    run.id,
    'test-no-verdict-cap-slot',
    plan,
    'dispatch',
    dependencies,
  );
  assert.equal(reviewerLaunches, 0);
  assert.equal(automatic.rejection?.code, 'PUBLICATION_REVIEW_LAUNCH_REJECTED');
  assert.match(
    automatic.rejection?.message ?? '',
    /^3\/3 reviewer attempts ended without a verdict/,
  );

  const operator = await executePublishGateReviewPlan(
    run.id,
    'test-no-verdict-cap-slot',
    plan,
    'human-gate',
    dependencies,
  );
  assert.equal(reviewerLaunches, 1);
  assert.equal(operator.rejection, undefined);
  assert.equal(getRun(run.id)!.engineState?.publishGate?.reviewLaunchRejection, undefined);
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
  assert.match(blocker.message, /FREED_SLOT_RESTORE_REQUIRED/);
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

test('WARM recheck updates its existing lineage and preserves attempt provenance', async (t) => {
  const previous = {
    id: 'review-bound',
    source: 'dispatch' as const,
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    mode: 'cold' as const,
    reviewerSessionId: 'retained',
    loopNumber: 1,
    verdict: 'pass' as const,
    unresolvedCount: 0,
    reviewedHeadSha: 'old',
    attempts: [
      { mode: 'cold' as const, loopNumber: 1, verdict: 'pass' as const, unresolvedCount: 0 },
    ],
  };
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: 'owner/repo#42',
    runner: 'codex',
    engineState: {
      publishGate: {
        reviews: [previous],
        reviewSequenceContext: {
          reviewLineages: [{ repository: 'owner/repo', prNumber: 42, reviewId: previous.id }],
        },
      },
    },
  });
  t.after(async () => deleteTestRunIfPresent(run.id));
  const result = await executePublishGateReviewPlan(
    run.id,
    'slot-1',
    [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high', mode: 'warm' }],
    'dispatch',
    {
      assertLaunchAllowed: async () => {},
      executeReview: async (_runId, _slotId, options = {}) => {
        assert.equal(options.reviewId, previous.id);
        assert.equal(options.priorAttempts?.length, 1);
        return {
          mode: 'warm',
          reviewId: previous.id,
          reviewerSessionId: 'retained',
          session: {
            mode: 'warm',
            continuity: 'resumed',
            reviewId: previous.id,
            repository: 'owner/repo',
            prNumber: 42,
            sessionId: 'retained',
            lastReviewedHeadSha: 'old',
          },
          verdict: 'pass',
          issues: [],
          retryCount: 0,
          attempts: [
            ...(options.priorAttempts ?? []),
            {
              mode: 'warm',
              loopNumber: 2,
              verdict: 'pass',
              unresolvedCount: 0,
              reviewSnapshot: {
                source: 'local-git',
                capturedAt: '2026-10-12T00:00:00Z',
                baseSha: 'old',
                headSha: 'new',
              },
            },
          ],
        };
      },
    },
  );
  assert.deepEqual(result.reviewIds, [previous.id]);
  const reviews = getRun(run.id)?.engineState?.publishGate?.reviews ?? [];
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].id, previous.id);
  assert.equal(reviews[0].loopNumber, 1);
  assert.equal(reviews[0].attempts?.length, 2);
  assert.equal(reviews[0].reviewedHeadSha, 'new');
});

test('a gate plan continues a pipeline lineage by its lineage id, under the row id; a person COLD and a refusal stay in it', async (t) => {
  const issues = [{ file: 'src/a.ts', line: 2, description: 'Bound the retry' }];
  // As recorded on bda11b1a: the pipeline row wraps its lineage in its own id.
  const lineageId = 'rev-claude-native-9e436a666c45-bc5247b7';
  const rowId = `pipeline-review-${lineageId}`;
  const taskDir = await mkdtemp(path.join(tmpdir(), 'gate-lineage-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  const run = createRun({
    flowType: 'dev',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-PREPUBLISH',
    runner: 'codex',
  });
  updateRun(run.id, {
    taskFile: path.join(taskDir, 'TASK.md'),
    engineState: {
      publishGate: {
        reviews: [
          {
            id: rowId,
            session: { mode: 'cold', continuity: 'fresh', reviewId: lineageId },
            source: 'pipeline',
            runner: 'codex',
            mode: 'cold',
            reviewerSessionId: 'retained',
            loopNumber: 1,
            verdict: 'issues',
            unresolvedCount: 1,
            issues,
            reviewedHeadSha: 'reviewed',
            reviewSnapshot: {
              source: 'local-git',
              capturedAt: '2026-10-20T00:00:00Z',
              headSha: 'reviewed',
            },
          },
        ],
      },
    },
  });
  t.after(async () => deleteTestRunIfPresent(run.id));
  const launches: Array<
    Parameters<NonNullable<PublishGateReviewPlanDependencies['executeReview']>>[2]
  > = [];
  const dependencies: PublishGateReviewPlanDependencies = {
    assertLaunchAllowed: async () => {},
    reviewSequenceContext: {
      reviewLineages: [{ reviewId: lineageId, familyId: run.familyId }],
    },
    executeReview: async (_runId, _slotId, options = {}) => {
      launches.push(options);
      // As the reviewer does: its session names the lineage it reviewed, its attempt the head.
      const session = {
        mode: options.mode ?? 'cold',
        continuity: options.mode === 'warm' ? ('resumed' as const) : ('fresh' as const),
        reviewId: options.reviewId ?? undefined,
        sessionId: `reviewer-${launches.length}`,
      };
      const attempt = {
        mode: session.mode,
        session,
        loopNumber: (options.priorAttempts?.length ?? 0) + 1,
        verdict: 'issues' as const,
        unresolvedCount: issues.length,
        issues,
        reviewSnapshot: {
          source: 'local-git' as const,
          capturedAt: '2026-10-20T00:00:00Z',
          headSha: 'reviewed',
        },
      };
      return {
        verdict: 'issues',
        issues,
        retryCount: 0,
        session,
        attempts: [...(options.priorAttempts ?? []), attempt],
      };
    },
  };
  const plan = (mode: 'warm' | 'cold') => [{ runner: 'codex', model: null, effort: null, mode }];
  await executePublishGateReviewPlan(run.id, 'slot-1', plan('warm'), 'dispatch', dependencies);
  assert.equal(launches[0]?.reviewId, lineageId);
  assert.equal(launches[0]?.artifactScope, rowId);
  assert.deepEqual(launches[0]?.rereview, { lastReviewedHeadSha: 'reviewed', priorIssues: issues });
  const rows = () => getRun(run.id)?.engineState?.publishGate?.reviews ?? [];
  assert.deepEqual(
    rows().map((review) => review.id),
    [rowId],
    'the result updates the lineage row in place',
  );
  // A person's COLD stays in the lineage: the same row, a fresh session for its lineage id.
  await executePublishGateReviewPlan(run.id, 'slot-1', plan('cold'), 'human-gate', dependencies);
  assert.equal(launches[1]?.mode, 'cold');
  assert.equal(launches[1]?.reviewId, lineageId);
  assert.equal(launches[1]?.artifactScope, rowId);
  assert.deepEqual(
    rows().map((review) => review.id),
    [rowId],
  );
  // A person's WARM request carries the same verified baseline and findings as automatic rechecks.
  await executePublishGateReviewPlan(run.id, 'slot-1', plan('warm'), 'human-gate', dependencies);
  assert.deepEqual(launches[2]?.rereview, { lastReviewedHeadSha: 'reviewed', priorIssues: issues });
  assert.equal(launches[2]?.mode, 'warm');
  // A refused handoff ran no session: its row says so, and keeps the lineage's earlier attempts.
  await executePublishGateReviewPlan(run.id, 'slot-1', plan('warm'), 'human-gate', {
    ...dependencies,
    executeReview: async () => {
      throw new Error('the retained reviewer could not resume: handoff refused');
    },
  });
  const [refused] = rows();
  assert.deepEqual(
    [refused.id, refused.verdict, refused.session, refused.reviewerSessionId],
    [rowId, 'failed', { mode: 'warm', continuity: 'refused', reviewId: lineageId }, null],
  );
  assert.equal(refused.reviewedHeadSha, undefined);
  assert.deepEqual(
    refused.attempts?.map((attempt) => [attempt.verdict, attempt.session?.sessionId]),
    [
      ['issues', 'reviewer-1'],
      ['issues', 'reviewer-2'],
      ['issues', 'reviewer-3'],
      ['failed', undefined],
    ],
  );
  // Reopening Request Review keeps the lineage visible and refuses unavailable WARM.
  const lineageOptions = await reviewLineageOptionsForRun(
    getRun(run.id)!,
    getAllRuns(),
    'reviewed',
    async () => true,
  );
  assert.deepEqual(
    lineageOptions.map((option) => [option.context, option.unavailableReason]),
    [
      [
        { familyId: run.familyId, reviewId: lineageId },
        'the reviewId has no verified retained session and reviewed head',
      ],
    ],
  );
  const picker = new ReviewDispatchViewModel({
    context: { allowedActions: ['request-review'], lineageOptions, defaults: { runner: 'codex' } },
  });
  assert.equal(picker.rows[0].selection.mode, 'warm');
  assert.match(
    picker.rows[0].note ?? '',
    /Cannot resume this review: the reviewId has no verified/,
  );
  assert.throws(() => picker.toRequestPayload(), /Cannot resume this review/);
  picker.setMode(picker.rows[0].id, 'cold');
  const request = picker.toRequestPayload();
  assert.deepEqual(request.context, {
    reviewLineages: [{ familyId: run.familyId, reviewId: lineageId }],
  });
  // Only an explicit COLD choice can launch a new reviewer, on the same lineage row.
  await executePublishGateReviewPlan(run.id, 'slot-1', picker.toSequence(), 'human-gate', {
    ...dependencies,
    reviewSequenceContext: request.context,
  });
  assert.deepEqual(
    [launches.at(-1)?.mode, launches.at(-1)?.reviewId, launches.at(-1)?.artifactScope],
    ['cold', lineageId, rowId],
  );
  assert.deepEqual(
    rows().map((review) => [review.id, review.verdict, review.session?.reviewId]),
    [[rowId, 'issues', lineageId]],
  );
});

function sourceGateFixture(t: TestContext) {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'missing-source-proof',
    ticketOrPr: 'SOURCE-WAIT',
  });
  updateRun(run.id, {
    status: 'human-gating',
    slotId: null,
    steps: [
      { name: 'human-gate', status: 'running' },
      { name: 'finalize', status: 'pending' },
    ],
    engineState: { publishGate: { packageId: 'retained', packageHash: 'retained-hash' } },
  });
  let notify!: () => void;
  const notice = () =>
    new Promise<void>((resolve) => {
      notify = resolve;
    });
  let announced = notice();
  const executions: Promise<string>[] = [];
  setEngineDecisionRuntime({
    broadcast: (event) => {
      if (event === Events.RUN_DECISION_NEW) notify();
    },
    stepToStatus: { 'human-gate': 'human-gating' },
  });
  t.after(async () => {
    updateRun(run.id, { status: 'cancelled' });
    for (const decision of getRun(run.id)!.decisions)
      if (!decision.resolvedAt) resolveEngineDecision(decision.id, 'abort');
    await Promise.allSettled(executions);
    await deleteTestRunIfPresent(run.id);
    setEngineDecisionRuntime({ broadcast: () => {}, stepToStatus: {} });
  });
  return {
    run,
    next: async (execution: Promise<string>): Promise<RunDecision> => {
      executions.push(execution);
      await Promise.race([
        announced,
        execution.then((action) => {
          throw new Error(`Gate returned ${action} before creating its wait`);
        }),
      ]);
      announced = notice();
      const decision = getRun(run.id)!.decisions.find((entry) => !entry.resolvedAt);
      assert.ok(decision);
      return decision;
    },
  };
}

for (const action of ['abort', 'hold']) {
  test(`a superseded publication gate stops before applying ${action} effects`, async (t) => {
    const { run } = sourceGateFixture(t);
    const prepared = makeReadyGatePackage({
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    });
    let afterReplay: Run | undefined;
    assert.equal(
      await executeReadyGate(run.id, {
        ensurePackage: async () => prepared,
        createDecision: async () => {
          const latest = getRun(run.id)!;
          afterReplay = structuredClone(
            updateRun(run.id, {
              status: 'blocked',
              engineState: {
                ...latest.engineState,
                generation: (latest.engineState?.generation ?? 0) + 1,
              },
            }),
          );
          return action;
        },
      }),
      'abort',
    );
    assert.deepEqual(getRun(run.id), afterReplay, 'the stale gate cannot mutate replay state');
  });
}

for (const action of ['approve-publish', 'approve-publish-unresolved']) {
  test(`accepted ${action} resumes its exact package without issuing another decision`, async (t) => {
    const { run } = sourceGateFixture(t);
    const prepared = makeReadyGatePackage({
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    });
    const decision: RunDecision = {
      id: 'accepted',
      type: 'engine_human_gate',
      title: 'Gate',
      description: '',
      actions: [],
      createdAt: '2026-10-15T00:00:00Z',
      resolvedAt: '2026-10-15T00:01:00Z',
      resolvedAction: action,
      selectionData: {
        packageId: prepared.id,
        packageHash: prepared.packageHash,
        packageHeadSha: prepared.headSha,
      },
      payload: {
        kind: 'ready',
        prNumber: null,
        repo: null,
        branch: prepared.branch,
        diffStat: prepared.diffStat,
        workerReport: '',
        prPackage: prepared,
      },
    };
    updateRun(run.id, {
      decisions: [decision],
      engineState: {
        publishGate: {
          publicationStatus: 'pending_publish',
          approvedPackageHash: prepared.packageHash,
        },
      },
    });
    assert.equal(
      await executeReadyGate(run.id, {
        ensurePackage: async () => prepared,
        createDecision: async () => assert.fail('accepted approval must not issue another gate'),
      }),
      action,
    );
    assert.equal(getRun(run.id)!.decisions.length, 1);
    assert.equal(
      getRun(run.id)!.engineState?.publishGate?.approvedPackageHash,
      prepared.packageHash,
    );
  });
}

test(
  'source-read failure uses the real decision owner and retains its publication wait',
  { timeout: 4000 },
  async (t) => {
    const { run, next } = sourceGateFixture(t);
    updateRun(run.id, { slotId: 'retained-source-slot' });
    const before = structuredClone(getRun(run.id)!);
    const execution = executeReadyGate(run.id, {
      ensurePackage: async () => {
        throw new Error('Owned source SSH connection unavailable');
      },
    });
    const card = await next(execution);
    assert.match(card.description, /SSH connection unavailable.*Restore the owned source/);
    assert.deepEqual(
      card.actions.map((entry) => entry.id),
      ['hold'],
    );
    assert.ok(card.payload?.kind === 'ready' && card.payload.stale && !card.payload.prPackage);
    const held = getRun(run.id)!;
    assert.equal(held.slotId, before.slotId);
    assert.deepEqual(held.engineState, before.engineState);
    assert.deepEqual(
      held.steps,
      before.steps.map((step) =>
        step.name === 'human-gate' ? { ...step, detail: 'Waiting for operator decision' } : step,
      ),
    );
    assert.notEqual(held.status, 'failed');
    assert.equal(resolveEngineDecision(card.id, 'abort'), true);
    assert.equal(await execution, 'abort');
  },
);

test('a gate that finds its worker busy waits for it to go idle and builds the package itself', async (t) => {
  const { run, next } = sourceGateFixture(t);
  const prepared = makeReadyGatePackage({
    reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
  });
  let builds = 0;
  const progress: RunProgressObservation['kind'][] = ['making-progress', 'idle'];
  const execution = executeReadyGate(run.id, {
    ensurePackage: async () => {
      if (++builds === 1) throw new OwnedWorkerBusyError(); // compacting when the gate opened
      return prepared;
    },
    readProgress: async (): Promise<RunProgressObservation> => ({
      kind: progress.shift() ?? 'idle',
    }),
    workerIdleWait: { pollMs: 1, timeoutMs: 2_000 },
  });
  const card = await next(execution);
  assert.equal(builds, 2, 'the package was built once the worker went idle');
  assert.doesNotMatch(card.description, /unavailable/);
  assert.ok(card.payload?.kind === 'ready' && card.payload.prPackage);
  assert.equal(resolveEngineDecision(card.id, 'abort'), true);
  assert.equal(await execution, 'abort');
});

test('a worker still busy after the bounded wait leaves the visible Retry Gate card', async (t) => {
  const { run, next } = sourceGateFixture(t);
  const execution = executeReadyGate(run.id, {
    ensurePackage: async () => {
      throw new OwnedWorkerBusyError();
    },
    readProgress: async (): Promise<RunProgressObservation> => ({ kind: 'making-progress' }),
    workerIdleWait: { pollMs: 1, timeoutMs: 20 },
  });
  const card = await next(execution);
  assert.match(card.description, /Wait for the owned worker to be idle/);
  assert.deepEqual(
    card.actions.map((entry) => entry.id),
    ['hold'],
  );
  assert.equal(resolveEngineDecision(card.id, 'abort'), true);
  assert.equal(await execution, 'abort');
});

test('Retry Gate reports preparation while its second source read is pending', async (t) => {
  let release!: () => void;
  t.after(() => release?.());
  const { run, next } = sourceGateFixture(t);
  let started!: () => void;
  const reading = new Promise<void>((resolve) => (started = resolve));
  const pending = new Promise<void>((resolve) => (release = resolve));
  let reads = 0;
  const execution = executeReadyGate(run.id, {
    ensurePackage: async () => {
      if (++reads === 2) {
        started();
        await pending;
      }
      throw new Error('Owned source is unavailable');
    },
  });
  const first = await next(execution);
  assert.equal(resolveEngineDecision(first.id, 'hold'), true);
  await reading;
  assert.equal(getRun(run.id)!.decisions.filter((decision) => !decision.resolvedAt).length, 0);
  assert.equal(
    getRun(run.id)!.steps.find((step) => step.name === 'human-gate')!.detail,
    'Preparing operator decision: checking publication package',
  );
  release();
  const second = await next(execution);
  assert.notEqual(second.id, first.id);
  assert.equal(
    getRun(run.id)!.steps.find((step) => step.name === 'human-gate')!.detail,
    'Waiting for operator decision',
  );
  assert.equal(resolveEngineDecision(second.id, 'abort'), true);
  assert.equal(await execution, 'abort');
});

test(
  'an unavailable package keeps the existing fix delivery reachable without approval',
  { timeout: 4000 },
  async (t) => {
    const { run, next } = sourceGateFixture(t);
    updateRun(run.id, {
      engineState: {
        publishGate: {
          reviews: [
            {
              id: 'review-current',
              source: 'human-gate',
              loopNumber: 4,
              mode: 'cold',
              verdict: 'issues',
              unresolvedCount: 1,
              issues: [{ file: 'icons.ts', description: 'Bound the SVG sniff' }],
              feedbackSent: false,
              recoveryContinuationPending: true,
            },
          ],
        },
      },
    });
    const execution = executeReadyGate(run.id, {
      ensurePackage: async () => {
        throw new Error('Deterministic CI gate blocked: REVIEW-FIX.md receipt is stale');
      },
    });
    const card = await next(execution);
    assert.deepEqual(
      card.actions.map(({ id }) => id),
      ['continue-review-fix', 'hold'],
    );
    assert.equal(resolveEngineDecision(card.id, 'continue-review-fix'), true);
    assert.equal(await execution, 'continue-review-fix');
    assert.equal(getRun(run.id)!.engineState?.publishGate?.reviews?.[0].feedbackSent, false);
    assert.equal(getRun(run.id)!.engineState?.publishGate?.approvedPackageHash, undefined);
  },
);

// TAT-4145 bda11b1a: a restart mid Continue Fixing dropped the loop that waited for the fix.
// The worker signalled complete (attempt bf04f28a) and the recovered gate moved on; the
// review-fix context stayed 'working', so the gate read a fix in progress.
const FIX_ATTEMPT = 'bf04f28a-b448-4127-8c0d-a273712e91d0';

function fixSignal(status: 'running' | 'complete', attemptId = FIX_ATTEMPT): string {
  return JSON.stringify({
    attemptId,
    step: status === 'complete' ? '8. Signal' : '6. CI parity',
    timestamp: '2026-10-20T03:47:43.386Z',
    status,
    ...(status === 'complete' ? { outcome: 'success', disposition: 'fixed' } : {}),
  });
}

/** The recorded gate: findings on review `fixed`, a working fix pass for them, no package. */
function staleFixGate(t: TestContext, laterReview?: 'pass') {
  const fixture = sourceGateFixture(t);
  const { run } = fixture;
  updateRun(run.id, {
    slotId: 'stale-fix-slot',
    agentContexts: [
      {
        id: 'review-fix',
        role: 'review-fix',
        label: 'Review fix',
        status: 'working',
        runner: 'claude',
        model: 'opus',
        taskFile: 'temp/tasks/feat/tat-4145/REVIEW-FIX.md',
        signalFile: 'temp/tasks/feat/tat-4145/REVIEW-FIX-SIGNAL.json',
        signalAttemptId: FIX_ATTEMPT,
        artifactScope: 'fixed',
        runId: run.id,
        slotId: 'stale-fix-slot',
        updatedAt: '2026-10-20T03:47:35.650Z',
      },
    ],
    engineState: {
      publishGate: {
        reviews: [
          {
            id: 'fixed',
            source: 'human-gate',
            loopNumber: 7,
            mode: 'cold',
            verdict: 'issues',
            unresolvedCount: 1,
            issues: [{ file: 'margin.ts', description: 'Drop the pick on a network change' }],
            feedbackSent: false,
            recoveryContinuationPending: true,
            retryCount: 0,
            maxRetries: 2,
          },
          ...(laterReview
            ? [
                {
                  id: 'requested',
                  source: 'human-gate' as const,
                  loopNumber: 8,
                  mode: 'cold' as const,
                  verdict: laterReview,
                  unresolvedCount: 0,
                  feedbackSent: false,
                },
              ]
            : []),
        ],
      },
    },
  });
  return fixture;
}

const refusedPackage = async (): Promise<never> => {
  throw new Error('Wait for the owned worker to be idle before refreshing its package');
};

test(
  'a finished fix pass Continue Fixing still resumes is left for that resume to adopt',
  { timeout: 4000 },
  async (t) => {
    const { run, next } = staleFixGate(t);
    const card = await next(
      executeReadyGate(run.id, {
        ensurePackage: refusedPackage,
        readReviewFixSignal: async () => fixSignal('complete'),
      }),
    );
    // Continue Fixing adopts the finished pass and re-reviews it (recoverReviewFixPass),
    // which needs the context unsettled.
    assert.equal(getRun(run.id)!.agentContexts?.[0]?.status, 'working');
    assert.deepEqual(
      card.actions.map(({ id }) => id),
      ['continue-review-fix', 'hold'],
    );
  },
);

test(
  'a gate settles a finished fix pass once a newer review replaced its findings',
  { timeout: 4000 },
  async (t) => {
    const { run, next } = staleFixGate(t, 'pass');
    let signal = fixSignal('complete', 'another-attempt');
    const execution = executeReadyGate(run.id, {
      ensurePackage: refusedPackage,
      readReviewFixSignal: async () => signal,
    });
    let card = await next(execution);
    assert.equal(getRun(run.id)!.agentContexts?.[0]?.status, 'working', 'not its own attempt');

    // The worker finishes while the gate waits; Retry Gate settles it before re-presenting.
    signal = fixSignal('complete');
    assert.equal(resolveEngineDecision(card.id, 'hold'), true);
    card = await next(execution);
    const settled = getRun(run.id)!.agentContexts?.[0];
    assert.equal(settled?.status, 'complete');
    assert.equal(settled?.lastSignalAt, '2026-10-20T03:47:43.386Z');
    assert.ok(settled?.completedAt);
    assert.deepEqual(
      card.actions.map(({ id }) => id),
      ['hold'],
    );
  },
);

test(
  'a gate re-binds an unowned slot before its package refresh reads the source',
  { timeout: 4000 },
  async (t) => {
    // TAT-4145 bda11b1a gate 42ac7052: the slot was reset during the replay, so the package
    // refresh refused with 'no longer owned' and the gate offered only Hold.
    const { run, next } = sourceGateFixture(t);
    const prepared = makeReadyGatePackage({
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    });
    let rebound = false;
    const execution = executeReadyGate(run.id, {
      rebindSlot: async () => (rebound = true),
      ensurePackage: async () => {
        if (!rebound) throw new Error('Publication source slot is no longer owned by this run');
        return prepared;
      },
    });
    const card = await next(execution);
    assert.doesNotMatch(card.description, /Publication package is unavailable/);
    assert.notDeepEqual(
      card.actions.map(({ id }) => id),
      ['hold'],
    );
  },
);

for (const mode of ['cold', 'warm', 'continue-review-fix'] as const) {
  test(`recovered source gate consumes ${mode} exactly once`, { timeout: 4000 }, async (t) => {
    const { run, next } = sourceGateFixture(t);
    const prepared = makeReadyGatePackage({
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    });
    let available = false;
    const dependencies = {
      ensurePackage: async () => {
        if (!available) throw new Error('Source disconnected');
        return prepared;
      },
    };
    const execution = executeReadyGate(run.id, dependencies);
    const card = await next(execution);
    const request: ReviewRequestPayload | undefined =
      mode === 'continue-review-fix'
        ? undefined
        : {
            runner: 'codex',
            model: null,
            effort: null,
            mode,
            ...(mode === 'warm'
              ? {
                  context: {
                    reviewLineages: [
                      { repository: 'owner/repo', prNumber: 42, reviewId: 'retained-lineage' },
                    ],
                  },
                }
              : {}),
          };
    // Inspection restores the card. RPC consumption stores these typed fields
    // before waking the real engine decision owner.
    available = true;
    card.payload = {
      kind: 'ready',
      prNumber: null,
      repo: null,
      workerReport: '',
      branch: prepared.branch,
      diffStat: prepared.diffStat,
      prPackage: prepared,
    };
    card.resolvedAt = new Date().toISOString();
    const action = request ? 'request-review' : 'continue-review-fix';
    card.resolvedAction = action;
    card.selectionData = request ? { reviewRequest: request } : {};
    if (!request)
      updateRun(run.id, {
        engineState: {
          ...getRun(run.id)!.engineState,
          publishGate: {
            ...getRun(run.id)!.engineState?.publishGate,
            reviews: [
              {
                id: 'review-1',
                source: 'human-gate',
                loopNumber: 1,
                mode: 'cold',
                verdict: 'issues',
                unresolvedCount: 1,
                issues: [{ file: 'example.ts', description: 'Retained finding' }],
                feedbackSent: false,
                recoveryContinuationPending: true,
              },
            ],
          },
        },
      });
    updateRun(run.id, { decisions: [card] });
    assert.equal(resolveEngineDecision(card.id, action), true);
    assert.equal(await execution, action);
    const after = getRun(run.id)!;
    if (request) {
      assert.equal(typeof after.decisions[0].context?.reviewRequestConsumedAt, 'string');
      assert.equal(after.engineState?.publishGate?.reviewSequence?.length, 1);
      assert.equal(after.engineState?.publishGate?.reviewSequence?.[0].mode, mode);
      assert.deepEqual(after.engineState?.publishGate?.reviewSequenceContext, request.context);
    }
    const repeated = executeReadyGate(run.id, dependencies);
    const nextCard = await next(repeated);
    assert.notEqual(nextCard.id, card.id, 'consumed requests cannot replay a second review');
    assert.equal(resolveEngineDecision(nextCard.id, 'abort'), true);
    assert.equal(await repeated, 'abort');
  });
}
