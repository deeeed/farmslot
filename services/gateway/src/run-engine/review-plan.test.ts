import assert from 'node:assert/strict';
import test from 'node:test';

import {
  automaticPublicationReviewPlan,
  humanGateReviewDepth,
  recoveryReviewPlanForActiveFix,
  remainingExplicitReviewPlan,
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
