import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRStatus } from '@farmslot/protocol';

import { prAttentionReasons } from './pr-attention.js';

function status(overrides: Partial<PRStatus> = {}): PRStatus {
  return {
    pr: 1,
    title: 'PR',
    summary: null,
    repo: 'org/app',
    headRef: null,
    project: 'app',
    slot: null,
    session: null,
    checks: [],
    checkSummary: { passed: 0, failed: 0, pending: 0, skipped: 0, total: 0 },
    allPassed: false,
    anyFailed: false,
    failedNames: [],
    botComments: [],
    actionableBotComments: [],
    prState: 'OPEN',
    merged: false,
    mergeable: 'MERGEABLE',
    mergeConflict: false,
    reviewDecision: '',
    recommendation: 'IN_REVIEW',
    ...overrides,
  } as PRStatus;
}

test('blocking reasons follow the recommendation order: conflict, CI, bot comments, changes requested', () => {
  const reasons = prAttentionReasons(
    status({
      mergeConflict: true,
      anyFailed: true,
      failedNames: ['lint', 'typecheck', 'unit', 'e2e'],
      actionableBotComments: [
        {
          author: 'cursor',
          label: 'bug',
          action: 'fix',
          bodyPreview: '',
          createdAt: '',
          source: '',
        },
      ] as PRStatus['actionableBotComments'],
      reviewDecision: 'CHANGES_REQUESTED',
    }),
  );
  assert.deepEqual(
    reasons.map((r) => r.kind),
    ['conflict', 'ci-failed', 'bot-comments', 'changes-requested'],
  );
  assert.equal(reasons[1].label, 'CI failed: lint, typecheck +2');
  assert.equal(reasons[2].label, '1 bot comment to address');
});

test('changes requested alone is a blocking reason', () => {
  const reasons = prAttentionReasons(status({ reviewDecision: 'CHANGES_REQUESTED' }));
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].kind, 'changes-requested');
  assert.equal(reasons[0].tone, 'fail');
});

test('an unwatched failing check is reported as a warning, with long names clipped', () => {
  const long = 'Appium Smoke Tests (Android) / appium-swap-android-smoke (1)';
  const reasons = prAttentionReasons(status({ allFailedNames: [long, 'docs-build'] }));
  assert.equal(reasons[0].kind, 'ci-failed');
  assert.equal(reasons[0].tone, 'warn');
  assert.equal(
    reasons[0].label,
    'Unwatched check failed: Appium Smoke Tests (Android) / …, docs-build',
  );
});

test('an unwatched failure never outranks the blocker that put the PR in Needs Attention', () => {
  const reasons = prAttentionReasons(
    status({ allFailedNames: ['docs-build'], reviewDecision: 'CHANGES_REQUESTED' }),
  );
  assert.deepEqual(
    reasons.map((r) => r.kind),
    ['changes-requested', 'ci-failed'],
  );
  assert.equal(reasons[1].tone, 'warn');
});

test('an unwatched failure trails the ready or waiting reason instead of leading it', () => {
  const ready = prAttentionReasons(
    status({ allPassed: true, reviewDecision: 'APPROVED', allFailedNames: ['docs-build'] }),
  );
  assert.deepEqual(
    ready.map((r) => r.kind),
    ['ready', 'ci-failed'],
  );
  const waiting = prAttentionReasons(
    status({ reviewDecision: 'REVIEW_REQUIRED', allFailedNames: ['docs-build'] }),
  );
  assert.deepEqual(
    waiting.map((r) => r.kind),
    ['review-required', 'ci-failed'],
  );
});

test('running-check names come from the same set as the count', () => {
  const reasons = prAttentionReasons(
    status({
      checks: [
        { name: 'unit', status: 'pending', watchName: 'unit' },
        { name: 'lint', status: 'pass', watchName: 'lint' },
      ],
      checkSummary: { passed: 1, failed: 0, pending: 1, skipped: 0, total: 2 },
      allPendingNames: ['unit', 'docs', 'e2e'],
    }),
  );
  assert.equal(reasons[0].label, '1 check running');
  assert.equal(reasons[0].detail, 'Still running: unit.');
});

test('non-blocking states report review wait, then pending checks', () => {
  const waiting = prAttentionReasons(
    status({
      reviewDecision: 'REVIEW_REQUIRED',
      checkSummary: { passed: 1, failed: 0, pending: 2, skipped: 0, total: 3 },
    }),
  );
  assert.deepEqual(
    waiting.map((r) => r.kind),
    ['review-required', 'ci-pending'],
  );
  assert.equal(waiting[1].label, '2 checks running');
});

test('approved with green CI reports ready; merged, closed, or worker-active PRs report nothing', () => {
  assert.equal(
    prAttentionReasons(status({ allPassed: true, reviewDecision: 'APPROVED' }))[0].kind,
    'ready',
  );
  assert.deepEqual(prAttentionReasons(status({ prState: 'MERGED', anyFailed: true })), []);
  assert.deepEqual(prAttentionReasons(status({ prState: 'CLOSED', mergeConflict: true })), []);
  assert.deepEqual(prAttentionReasons(status({ workerActive: true, anyFailed: true })), []);
});
