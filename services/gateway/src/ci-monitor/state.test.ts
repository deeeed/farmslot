import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import {
  ciHoldBarrier,
  ciHoldIsQuiet,
  ciHoldSince,
  emptyCiWatchState,
  readDedup,
  resetInlineFixConsecutiveAttempts,
} from './state.js';

test('resetInlineFixConsecutiveAttempts clears consecutive inline-fix window only', async (t) => {
  const run = createRun({
    flowType: 'pr-complete',
    project: 'demo',
    ticketOrPr: `org/repo#${Date.now()}`,
  });
  t.after(async () => {
    if (getRun(run.id)) await deleteRun(run.id);
  });

  updateRun(run.id, {
    status: 'done',
    completedAt: new Date().toISOString(),
    ciWatchState: { ...emptyCiWatchState(), consecutiveAttempts: 2, totalAttempts: 5 },
  });
  resetInlineFixConsecutiveAttempts(run.id);

  const state = readDedup(run.id);
  assert.equal(state.consecutiveAttempts, 0);
  assert.equal(state.totalAttempts, 5);
});

const DISPATCH = {
  id: 'dispatch-pr-complete',
  label: 'Dispatch pr-complete',
  style: 'primary' as const,
};
const WAIT = { id: 'wait', label: 'Keep watching CI', style: 'secondary' as const };
const ABORT = { id: 'abort', label: 'Abort', style: 'danger' as const };

function decision(
  type: string,
  actions: RunDecision['actions'],
  resolvedAction: string | undefined,
  resolvedAt: string | undefined,
): RunDecision {
  return {
    id: `${type}-${resolvedAt ?? 'open'}`,
    type: type as RunDecision['type'],
    title: type,
    description: type,
    actions,
    createdAt: '2026-11-24T13:00:00.000Z',
    ...(resolvedAt ? { resolvedAt, resolvedAction } : {}),
  };
}

test('wait at inline_fix_blocked, offered beside a dispatch, holds the PR', () => {
  // Run fcfb5124: the gate offered dispatch-pr-complete, wait and abort, and the
  // operator chose wait. That is the hold; nothing recorded it before.
  const held = ciHoldSince({
    decisions: [
      decision(
        'ci_inline_fix_blocked',
        [DISPATCH, WAIT, ABORT],
        'wait',
        '2026-11-24T13:28:57.000Z',
      ),
    ],
  });
  assert.equal(held, '2026-11-24T13:28:57.000Z');
});

test('only that gate and that choice hold the PR', () => {
  // The same gate without a dispatch on offer is a cancelled or timed-out check:
  // "keep watching" a flaky runner is not taking manual control.
  assert.equal(
    ciHoldSince({
      decisions: [
        decision('ci_inline_fix_blocked', [WAIT, ABORT], 'wait', '2026-11-24T13:28:57.000Z'),
      ],
    }),
    undefined,
  );
  // review_comments_early's "Wait for CI first" keeps its one-shot meaning.
  assert.equal(
    ciHoldSince({
      decisions: [
        decision('ci_review_comments_early', [DISPATCH, WAIT], 'wait', '2026-11-24T13:28:57.000Z'),
      ],
    }),
    undefined,
  );
  // An unanswered gate holds nothing, and neither does another action at the hold gate.
  assert.equal(
    ciHoldSince({
      decisions: [decision('ci_inline_fix_blocked', [DISPATCH, WAIT], undefined, undefined)],
    }),
    undefined,
  );
  assert.equal(
    ciHoldSince({
      decisions: [
        decision(
          'ci_inline_fix_blocked',
          [DISPATCH, WAIT, ABORT],
          'abort',
          '2026-11-24T13:28:57.000Z',
        ),
      ],
    }),
    undefined,
  );
});

test('a later retry or a ci-watch replay hands the PR back', () => {
  const hold = decision(
    'ci_inline_fix_blocked',
    [DISPATCH, WAIT],
    'wait',
    '2026-11-24T13:28:57.000Z',
  );
  assert.equal(
    ciHoldSince({
      decisions: [
        hold,
        decision(
          'ci_ci_failed',
          [DISPATCH, { id: 'retry', label: 'Retry CI', style: 'secondary' }],
          'retry',
          '2026-11-24T14:00:00.000Z',
        ),
      ],
    }),
    undefined,
    'a retry after the hold releases it',
  );
  assert.equal(
    ciHoldSince({
      decisions: [hold],
      ciWatchState: { ...emptyCiWatchState(), holdReleasedAt: '2026-11-24T14:00:00.000Z' },
    }),
    undefined,
    'a replay that re-ran ci-watch releases it',
  );
  // A release before the hold does not cancel a later hold.
  assert.equal(
    ciHoldSince({
      decisions: [hold],
      ciWatchState: { ...emptyCiWatchState(), holdReleasedAt: '2026-11-24T13:00:00.000Z' },
    }),
    '2026-11-24T13:28:57.000Z',
  );
});

test('only the latest "Keep holding", for this state, in this hold, quiets a gate', () => {
  const hold = decision(
    'ci_inline_fix_blocked',
    [DISPATCH, WAIT],
    'wait',
    '2026-11-24T13:28:57.000Z',
  );
  const kept = (resolvedAt: string, holdKey: string): RunDecision => ({
    ...decision('ci_merge_conflict', [WAIT], 'wait', resolvedAt),
    context: { holdKey },
  });
  const run = { decisions: [hold, kept('2026-11-24T13:40:00.000Z', 'A')] };
  assert.equal(ciHoldIsQuiet(run, 'merge_conflict', 'A'), true);
  assert.equal(ciHoldIsQuiet(run, 'merge_conflict', 'B'), false, 'another state asks');
  assert.equal(ciHoldIsQuiet(run, 'ci_failed', 'A'), false, 'another gate asks');
  assert.equal(
    ciHoldIsQuiet(
      {
        ...run,
        ciWatchState: {
          ...emptyCiWatchState(),
          holdClearedAt: { merge_conflict: '2026-11-24T13:50:00.000Z' },
        },
      },
      'merge_conflict',
      'A',
    ),
    false,
    'the state was seen to clear after the answer',
  );
  assert.equal(
    ciHoldIsQuiet(
      {
        decisions: [
          hold,
          kept('2026-11-24T13:40:00.000Z', 'A'),
          kept('2026-11-24T13:45:00.000Z', 'B'),
        ],
      },
      'merge_conflict',
      'A',
    ),
    false,
    'a later answer for another state replaces it',
  );
  assert.equal(
    ciHoldIsQuiet(
      { decisions: [kept('2026-11-24T13:00:00.000Z', 'A'), hold] },
      'merge_conflict',
      'A',
    ),
    false,
    'an answer from before the hold does not count',
  );
  assert.equal(
    ciHoldIsQuiet({ decisions: [kept('2026-11-24T13:40:00.000Z', 'A')] }, 'merge_conflict', 'A'),
    false,
  );
});

test('the reuse barrier is the latest wait on any CI gate in the hold', () => {
  const hold = decision(
    'ci_inline_fix_blocked',
    [DISPATCH, WAIT],
    'wait',
    '2026-11-24T13:28:57.000Z',
  );
  assert.equal(ciHoldBarrier({ decisions: [hold] }), '2026-11-24T13:28:57.000Z');
  assert.equal(
    ciHoldBarrier({
      decisions: [hold, decision('ci_ci_failed', [WAIT], 'wait', '2026-11-24T14:00:00.000Z')],
    }),
    '2026-11-24T14:00:00.000Z',
  );
  assert.equal(
    ciHoldBarrier({
      decisions: [decision('ci_ci_failed', [WAIT], 'wait', '2026-11-24T14:00:00.000Z')],
    }),
    undefined,
  );
});
