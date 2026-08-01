import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

import {
  automaticPublicationReviewPlan,
  humanGateReviewDepth,
  latestResolvedHumanGateReviewRequestDecision,
  recoveryReviewPlanForActiveFix,
  remainingExplicitReviewPlan,
  resolveHumanGateReviewExecutionPlan,
  reviewPlanFromSelection,
} from './review-plan.js';

test('automatic publication reviews materialize the policy as static independent work', () => {
  const policy = {
    minimumIndependentReviews: 1,
    requireCrossRunner: false,
    extraLoopsRequested: 0,
    requestedBy: 'dispatch' as const,
  };
  assert.deepEqual(automaticPublicationReviewPlan(policy, [], 'claude'), [
    { order: 1, runner: 'same', validationDepth: 'static-code' },
  ]);
  assert.deepEqual(
    automaticPublicationReviewPlan(
      policy,
      [
        {
          id: 'self-review-1',
          source: 'self-review',
          runner: 'claude',
          crossRunner: false,
          loopNumber: 1,
          verdict: 'pass',
          unresolvedCount: 0,
          validationDepth: 'static-code',
        },
      ],
      'claude',
    ),
    [{ order: 1, runner: 'same', validationDepth: 'static-code' }],
    'worker self-review must not consume the independent-review minimum',
  );
});

test('automatic publication reviews select an alternate runner only when policy requires it', () => {
  const policy = {
    minimumIndependentReviews: 1,
    requireCrossRunner: true,
    extraLoopsRequested: 0,
    requestedBy: 'dispatch' as const,
  };
  assert.deepEqual(automaticPublicationReviewPlan(policy, [], 'claude'), [
    { order: 1, runner: 'codex', validationDepth: 'static-code' },
  ]);
});

test('explicit publication review plans remain authoritative when the policy minimum is zero', () => {
  const plan = [
    { order: 1, runner: 'codex' as const, validationDepth: 'full-live' as const },
    { order: 2, runner: 'same' as const, validationDepth: 'static-code' as const },
  ];

  assert.deepEqual(remainingExplicitReviewPlan(plan, []), plan);
});

test('explicit publication review recovery drops the already-passed prefix', () => {
  const plan = [
    { order: 1, runner: 'codex' as const, validationDepth: 'full-live' as const },
    { order: 2, runner: 'same' as const, validationDepth: 'static-code' as const },
  ];

  assert.deepEqual(
    remainingExplicitReviewPlan(plan, [
      {
        id: 'independent-review-1',
        source: 'dispatch',
        runner: 'codex',
        crossRunner: true,
        loopNumber: 1,
        verdict: 'pass',
        unresolvedCount: 0,
      },
    ]),
    [plan[1]],
  );
});

test('explicit publication review recovery ignores passes from an earlier work order', () => {
  const plan = [{ order: 1, runner: 'codex' as const, validationDepth: 'static-code' as const }];
  const reviews = [
    {
      id: 'earlier-human-review',
      source: 'human-gate' as const,
      runner: 'codex',
      crossRunner: true,
      loopNumber: 1,
      verdict: 'pass' as const,
      unresolvedCount: 0,
      completedAt: '2026-07-30T01:00:00.000Z',
    },
  ];

  assert.deepEqual(
    remainingExplicitReviewPlan(plan, reviews, {
      requestedAt: '2026-07-30T02:00:00.000Z',
      source: 'human-gate',
    }),
    plan,
  );
  assert.deepEqual(
    remainingExplicitReviewPlan(
      plan,
      [{ ...reviews[0], id: 'current-human-review', completedAt: '2026-07-30T03:00:00.000Z' }],
      {
        requestedAt: '2026-07-30T02:00:00.000Z',
        source: 'human-gate',
      },
    ),
    [],
  );
});

test('explicit publication review recovery preserves a missing runner-specific prefix', () => {
  const plan = [
    { order: 1, runner: 'codex' as const, validationDepth: 'static-code' as const },
    { order: 2, runner: 'same' as const, validationDepth: 'static-code' as const },
  ];

  assert.deepEqual(
    remainingExplicitReviewPlan(
      plan,
      [
        {
          id: 'second-loop-pass',
          source: 'human-gate',
          runner: 'claude',
          crossRunner: false,
          loopNumber: 2,
          verdict: 'pass',
          unresolvedCount: 0,
          completedAt: '2026-07-30T03:00:00.000Z',
        },
      ],
      {
        requestedAt: '2026-07-30T02:00:00.000Z',
        source: 'human-gate',
      },
    ),
    plan,
  );
});

test('reviewPlanFromSelection honors explicit loop runners', () => {
  assert.deepEqual(
    reviewPlanFromSelection({
      reviewRequest: {
        extraLoopsRequested: 1,
        requireCrossRunner: true,
        loops: [{ order: 1, runner: 'codex', validationDepth: 'static-code' }],
      },
    }),
    [{ order: 1, runner: 'codex', model: null, validationDepth: 'static-code' }],
  );
});

test('resolveHumanGateReviewExecutionPlan prefers latest codex request over stale claude pending', () => {
  // Reproduction of run 71803bd2: decision[1] requested codex while pending
  // still held claude from the first request / wrong plan preference.
  const stalePending = [
    { order: 1, runner: 'claude' as const, validationDepth: 'static-code' as const },
  ];
  const decisions: RunDecision[] = [
    {
      id: 'd0',
      type: 'engine_human_gate',
      title: 'first',
      description: '',
      actions: [],
      createdAt: '2026-08-01T13:41:00.000Z',
      resolvedAt: '2026-08-01T13:41:47.116Z',
      resolvedAction: 'request-extra-review',
      selectionData: {
        reviewRequest: {
          extraLoopsRequested: 1,
          requireCrossRunner: true,
          loops: [{ order: 1, runner: 'claude', validationDepth: 'static-code' }],
        },
      },
      context: { reviewRequestConsumedAt: '2026-08-01T13:41:47.119Z' },
    },
    {
      id: 'd1',
      type: 'engine_human_gate',
      title: 'second',
      description: '',
      actions: [],
      createdAt: '2026-08-01T14:07:13.000Z',
      resolvedAt: '2026-08-01T14:19:17.296Z',
      resolvedAction: 'request-extra-review',
      selectionData: {
        reviewRequest: {
          extraLoopsRequested: 1,
          requireCrossRunner: true,
          loops: [{ order: 1, runner: 'codex', validationDepth: 'static-code' }],
        },
      },
    },
  ];

  const plan = resolveHumanGateReviewExecutionPlan({
    gateAction: 'request-extra-review',
    pendingPlan: stalePending,
    decisions,
  });
  assert.equal(plan[0]?.runner, 'codex', 'second request must launch codex, not stale claude');
  assert.deepEqual(plan, [
    { order: 1, runner: 'codex', model: null, validationDepth: 'static-code' },
  ]);

  // Old buggy path: prefer pending when non-empty, ignore decision selection.
  const buggyPlan = stalePending.length
    ? stalePending
    : reviewPlanFromSelection(
        latestResolvedHumanGateReviewRequestDecision(decisions)?.selectionData,
      );
  assert.equal(buggyPlan[0]?.runner, 'claude', 'documents the pre-fix failure mode');
});

test('resolveHumanGateReviewExecutionPlan falls back to pending when selection has no explicit runner', () => {
  const pending = [{ order: 1, runner: 'cursor' as const, validationDepth: 'full-live' as const }];
  const decisions: RunDecision[] = [
    {
      id: 'd0',
      type: 'engine_human_gate',
      title: 'count-only',
      description: '',
      actions: [],
      createdAt: '2026-08-01T13:00:00.000Z',
      resolvedAt: '2026-08-01T13:01:00.000Z',
      resolvedAction: 'request-extra-review',
      selectionData: {
        reviewRequest: { extraLoopsRequested: 1, requireCrossRunner: true },
      },
    },
  ];
  const plan = resolveHumanGateReviewExecutionPlan({
    gateAction: 'request-extra-review',
    pendingPlan: pending,
    decisions,
  });
  assert.deepEqual(plan, pending);
});

test('humanGateReviewDepth makes explicit gate review requests temporary but required', () => {
  const basePolicy = {
    minimumIndependentReviews: 0,
    requireCrossRunner: false,
    extraLoopsRequested: 0,
    requestedBy: 'dispatch' as const,
  };

  assert.deepEqual(
    humanGateReviewDepth(
      basePolicy,
      {},
      { actionId: 'request-extra-review', fallbackLoopCount: 1 },
    ),
    {
      minimumIndependentReviews: 1,
      requireCrossRunner: false,
      extraLoopsRequested: 0,
      requestedBy: 'human-gate',
    },
  );

  assert.deepEqual(
    humanGateReviewDepth(basePolicy, {}, { actionId: 'request-cross-runner-review' }),
    {
      minimumIndependentReviews: 1,
      requireCrossRunner: true,
      extraLoopsRequested: 0,
      requestedBy: 'human-gate',
    },
  );
});

test('recoveryReviewPlanForActiveFix restores the latest reviewer work order', () => {
  assert.deepEqual(
    recoveryReviewPlanForActiveFix({
      agentContexts: [
        {
          id: 'rev-codex',
          role: 'self-review',
          label: 'Reviewer',
          status: 'complete',
          slotId: 'slot-1',
          runId: 'run-1',
          runner: 'codex',
          model: 'gpt-5.6-sol',
          attemptStartedAt: '2026-07-30T03:24:00.000Z',
        },
        {
          id: 'self-review-fix',
          role: 'self-review-fix',
          label: 'Review fix',
          status: 'working',
          slotId: 'slot-1',
          runId: 'run-1',
          startedAt: '2026-07-30T03:30:00.000Z',
        },
      ],
      engineState: {
        publishGate: {
          independentReviews: [
            {
              id: 'independent-review-1',
              source: 'human-gate',
              runner: 'codex',
              crossRunner: true,
              loopNumber: 1,
              verdict: 'issues',
              unresolvedCount: 1,
              validationDepth: 'static-code',
            },
          ],
        },
      },
    }),
    [
      {
        order: 1,
        runner: 'codex',
        model: 'gpt-5.6-sol',
        validationDepth: 'static-code',
      },
    ],
  );
});

test('recoveryReviewPlanForActiveFix ignores completed fix contexts', () => {
  assert.deepEqual(
    recoveryReviewPlanForActiveFix({
      agentContexts: [
        {
          id: 'self-review-fix',
          role: 'self-review-fix',
          label: 'Review fix',
          status: 'complete',
          slotId: 'slot-1',
          runId: 'run-1',
        },
      ],
    }),
    [],
  );
});
