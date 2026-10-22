import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewHistoryRound } from '@farmslot/review-dispatch';

import { litBindings, litText } from '../../testing/lit-text.js';

import { renderReviewAttempt, renderReviewFix } from './step-inspector-review-renderer.js';

function round(overrides: Partial<ReviewHistoryRound> = {}): ReviewHistoryRound {
  return {
    key: 'review:2',
    reviewId: 'review',
    loopNumber: 2,
    roundNumber: 2,
    headSha: 'bbbbbbb',
    reviewBaseSha: 'aaaaaaa',
    resultRecorded: true,
    runner: 'codex',
    model: 'gpt-6.1-sol',
    mode: 'warm',
    modeLabel: 'WARM',
    verdict: 'issues',
    verdictTone: 'warn',
    startedAt: '2026-10-21T10:00:00Z',
    completedAt: '2026-10-21T10:02:00Z',
    durationMs: 120000,
    unresolvedCount: 1,
    unresolvedLabel: '1 unresolved',
    findingsLabel: '1 finding recorded.',
    findings: [
      {
        id: 'fill',
        status: 'new',
        statusLabel: 'New',
        resolvedBy: null,
        title: 'Missing fill',
        details: '',
        severity: 'Severity not recorded',
        file: 'order.ts',
        line: 462,
      },
    ],
    earlierAttempts: [],
    reviewRange: 'aaaaaaa → bbbbbbb',
    fixRange: null,
    fixStat: null,
    fixDurationMs: null,
    fixStartedAt: null,
    fixCompletedAt: null,
    fixFiles: [],
    fixRunning: false,
    activeFixStartedAt: null,
    hasFix: false,
    diffPath: null,
    diffText: null,
    diffReconstructed: false,
    fixBaseSha: null,
    fixHeadSha: null,
    fixReconstructed: false,
    reviewDiffRetained: false,
    fixDiffPath: null,
    fixDiffText: null,
    fixDiffError: null,
    validationDepth: 'static-code',
    timing: [],
    unavailable: [],
    ...overrides,
  };
}

test('the shared round shows reviewer, mode, start, duration and exact finding location', () => {
  const text = litText(
    renderReviewAttempt(
      round(),
      false,
      () => undefined,
      () => undefined,
      () => undefined,
    ),
  );
  for (const label of [
    'Round 2',
    'codex',
    'gpt-6.1-sol',
    'WARM',
    'order.ts:462',
    'Missing fill',
    'Severity not recorded',
  ])
    assert.ok(text.includes(label), label);
  assert.doesNotMatch(text, /worker fix applied/);
});

test('a fix is a separate timeline card with changed files and the existing diff action', () => {
  const opened: string[] = [];
  const view = renderReviewFix(
    {
      key: 'fix',
      reconstructed: false,
      diffError: null,
      verifiedAt: null,
      label: 'Fix before round 2',
      startedAt: null,
      completedAt: null,
      durationMs: 60000,
      running: false,
      range: 'aaaaaaa → bbbbbbb',
      stat: '2 files · +3 −1',
      files: ['order.ts', 'order.test.ts'],
      diffPath: 'artifacts/fix.diff',
      diffText: 'diff --git',
      resolved: [],
    },
    (path) => opened.push(path),
  );
  const text = litText(view);
  assert.match(text, /Fix before round 2/);
  assert.match(text, /2 files/);
  assert.match(text, /order.test.ts/);
  assert.doesNotMatch(text, /Resolved findings: Not recorded/);
  const click = litBindings(view, '@click=')[0];
  assert.equal(typeof click, 'function');
  if (typeof click === 'function') click();
  assert.deepEqual(opened, ['artifacts/fix.diff']);
});

test('a finding opens its reviewed source independently of the diff', () => {
  const selected: string[] = [];
  const view = renderReviewAttempt(
    round(),
    false,
    () => undefined,
    (finding) => selected.push(finding.file + ':' + finding.line),
    () => undefined,
  );
  const click = litBindings(view, '@click=')[0];
  if (typeof click === 'function') click();
  assert.deepEqual(selected, ['order.ts:462']);
});
