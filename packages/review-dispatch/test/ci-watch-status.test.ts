import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { ciWatchStatusView } from '../src/ci-watch-status.js';

const now = Date.parse('2026-10-23T12:00:00Z');
function run(outputs: Record<string, unknown> = {}): Run {
  return {
    id: 'ci-run',
    familyId: 'family',
    lane: 'production',
    flowType: 'dev',
    mode: 'interactive',
    status: 'ci-watching',
    project: 'demo',
    ticketOrPr: 'DEMO-1',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [
      {
        name: 'ci-watch',
        status: 'running',
        outputs: {
          checkSummary: { passed: 23, failed: 1, pending: 5, total: 29 },
          failedNames: ['run-security-scan'],
          nextPollAt: new Date(now + 180_000).toISOString(),
          progressTimeoutAt: new Date(now + 47 * 60_000).toISOString(),
          totalTimeoutAt: new Date(now + 180 * 60_000).toISOString(),
          ...outputs,
        },
      },
    ],
    decisions: [],
    metrics: { nudgeCount: 0, runner: null, model: null },
    createdAt: '2026-10-23T10:00:00Z',
    updatedAt: '2026-10-23T12:00:00Z',
  };
}

test('CI card names failures, pending checks, next poll and the earliest real engine deadline', () => {
  assert.equal(
    ciWatchStatusView(run(), now)?.label,
    'CI 23/29 · 1 failed: run-security-scan · 5 pending · next check 3m · times out in 47m',
  );
  assert.match(
    ciWatchStatusView(run({ totalTimeoutAt: new Date(now + 12 * 60_000).toISOString() }), now)
      ?.label ?? '',
    /times out in 12m$/,
  );
});

test('countdowns tick and clamp without declaring a decision before the engine raises it', () => {
  assert.match(
    ciWatchStatusView(run(), now + 130_000)?.label ?? '',
    /next check 50s · times out in 45m$/,
  );
  assert.match(
    ciWatchStatusView(run(), now + 60_000)?.label ?? '',
    /next check 2m · times out in 46m$/,
  );
  assert.match(
    ciWatchStatusView(run(), now + 48 * 60_000)?.label ?? '',
    /next check now · timeout due$/,
  );
});

test('all-green checks still explain actionable feedback and an active fix', () => {
  const input = run({
    checkSummary: { passed: 29, failed: 0, pending: 0, total: 29 },
    failedNames: [],
    actionableBotCommentCount: 2,
    phase: 'waiting_for_worker',
    nextPollAt: null,
  });
  assert.match(
    ciWatchStatusView(input, now)?.label ?? '',
    /^CI 29\/29 · 2 actionable comments · worker fixing/,
  );
});

test('decisions and pauses stop countdowns; terminal or unrelated runs omit the CI line', () => {
  const input = run({ phase: 'decision_required' });
  assert.match(ciWatchStatusView(input, now)?.label ?? '', /waiting for input$/);
  assert.equal(ciWatchStatusView(input, now)?.live, false);
  input.status = 'paused';
  assert.match(ciWatchStatusView(input, now)?.label ?? '', /paused$/);
  input.status = 'done';
  assert.equal(ciWatchStatusView(input, now), null);
  const other = run();
  other.status = 'monitoring';
  other.steps = [];
  assert.equal(ciWatchStatusView(other, now), null);
});

test('legacy snapshots never invent a timeout from default limits or an old step start', () => {
  const view = ciWatchStatusView(
    run({ progressTimeoutAt: undefined, totalTimeoutAt: undefined, nextPollAt: null }),
    now,
  );
  assert.match(view?.label ?? '', /checking now · timeout unavailable$/);
});
