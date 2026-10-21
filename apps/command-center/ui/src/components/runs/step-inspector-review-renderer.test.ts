import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewHistoryRound } from '@farmslot/review-dispatch';

import { litBindings, litText } from '../../testing/lit-text.js';

import { renderReviewAttempt } from './step-inspector-review-renderer.js';

function round(overrides: Partial<ReviewHistoryRound> = {}): ReviewHistoryRound {
  return {
    key: 'review:2',
    reviewId: 'review',
    loopNumber: 2,
    runner: 'codex',
    model: 'gpt-6.1-sol',
    mode: 'warm',
    modeLabel: 'WARM',
    verdict: 'issues',
    startedAt: '2026-10-21T10:00:00Z',
    completedAt: '2026-10-21T10:02:00Z',
    durationMs: 120000,
    unresolvedCount: 1,
    unresolvedLabel: '1 unresolved',
    findingsLabel: '1 finding recorded.',
    findings: [
      {
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
    fixRunning: false,
    activeFixStartedAt: null,
    resolution: 'Not recorded',
    hasFix: false,
    diffPath: null,
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
  const text = litText(renderReviewAttempt(round(), -1));
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

test('a fix keeps its SHA and diffstat while missing resolution and duration remain explicit', () => {
  const text = litText(
    renderReviewAttempt(
      round({ hasFix: true, fixRange: 'aaaaaaa → bbbbbbb', fixStat: '2 files · +3 −1' }),
      0,
    ),
  );
  assert.match(text, /Fix before round 2/);
  assert.match(text, /2 files/);
  assert.match(text, /Fix duration not recorded/);
  assert.match(text, /Resolved findings: Not recorded/);
});

test('the recorded diff action opens the existing artifact viewer', () => {
  const opened: string[] = [];
  const view = renderReviewAttempt(
    round({ fixDiffPath: 'artifacts/round-2/fix.diff' }),
    0,
    (path) => opened.push(path),
  );
  const clicks = litBindings(view, '@click=');
  assert.equal(clicks.length, 1);
  const click = clicks[0];
  assert.equal(typeof click, 'function');
  if (typeof click === 'function') click();
  assert.deepEqual(opened, ['artifacts/round-2/fix.diff']);
});
