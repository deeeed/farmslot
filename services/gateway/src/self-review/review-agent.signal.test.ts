import assert from 'node:assert/strict';
import test from 'node:test';

import { resumableSessionProbeCommand } from '../runners/session-process.js';

import { parseStructuredReviewFeedback } from './feedback.js';
import { applyTerminalReviewSignal, parseTerminalSelfReviewSignal } from './review-agent.js';
import {
  isSuccessfulTerminalReviewSignal,
  terminalReviewArtifactErrorForCompletion,
} from './terminal-result.js';

test('parseTerminalSelfReviewSignal ignores progress mark signals (status running)', () => {
  const raw = JSON.stringify({
    status: 'running',
    step: '3. Read every changed file',
    timestamp: '2026-07-06T15:12:29.756Z',
  });
  assert.equal(parseTerminalSelfReviewSignal(raw), undefined);
});

test('parseTerminalSelfReviewSignal accepts terminal mark complete signal', () => {
  const raw = JSON.stringify({
    status: 'complete',
    outcome: 'success',
    disposition: 'fixed',
    timestamp: '2026-07-06T16:00:00.000Z',
  });
  const signal = parseTerminalSelfReviewSignal(raw);
  assert.equal(signal?.status, 'complete');
});

test('blocked reviewer signal cannot become a passing review', () => {
  const signal = parseTerminalSelfReviewSignal(
    JSON.stringify({
      status: 'blocked',
      outcome: 'partial',
      disposition: 'blocked',
      reason: 'reviewer quota exhausted',
    }),
  );

  assert.deepEqual(applyTerminalReviewSignal({ verdict: 'pass', issues: [] }, signal), {
    verdict: 'pass',
    issues: [],
    incomplete: true,
  });
});

test('terminal done reviewer signal preserves its parsed verdict', () => {
  const signal = parseTerminalSelfReviewSignal(
    JSON.stringify({ status: 'done', outcome: 'success', disposition: 'fixed' }),
  );

  assert.deepEqual(applyTerminalReviewSignal({ verdict: 'pass', issues: [] }, signal), {
    verdict: 'pass',
    issues: [],
  });
});

test('only complete and done are successful reviewer terminal signals', () => {
  assert.equal(isSuccessfulTerminalReviewSignal({ status: 'complete' }), true);
  assert.equal(isSuccessfulTerminalReviewSignal({ status: 'done' }), true);
  assert.equal(isSuccessfulTerminalReviewSignal({ status: 'failed' }), false);
  assert.equal(isSuccessfulTerminalReviewSignal({ status: 'blocked' }), false);
});

test('established completion makes an invalid structured result terminal', () => {
  const error = terminalReviewArtifactErrorForCompletion(
    'reviewer-1',
    'review-result.json is invalid',
  );

  assert.match(error?.message ?? '', /review-result\.json is invalid/);
});

test('structured result parser preserves schema v1 issues and fails closed on corruption', () => {
  assert.deepEqual(
    parseStructuredReviewFeedback(
      JSON.stringify({
        schemaVersion: 1,
        verdict: 'ISSUES',
        issues: [{ file: 'src/review.ts', line: null, description: 'Keep this finding.' }],
      }),
      'artifacts/review-result.json',
    ),
    {
      verdict: 'issues',
      issues: [{ file: 'src/review.ts', description: 'Keep this finding.' }],
    },
  );
  const invalidCardinality = parseStructuredReviewFeedback(
    JSON.stringify({
      schemaVersion: 1,
      verdict: 'PASS',
      issues: [{ file: 'src/review.ts', description: 'Pass cannot contain findings.' }],
    }),
    'artifacts/review-result.json',
  );
  assert.equal(invalidCardinality.incomplete, true);
  const corrupt = parseStructuredReviewFeedback('{', 'artifacts/review-result.json');
  assert.equal(corrupt.verdict, 'issues');
  assert.equal(corrupt.incomplete, true);
  assert.match(corrupt.terminalInvalidReason ?? '', /not valid JSON/);
});

test('parseTerminalSelfReviewSignal rejects legacy substring-only detection', () => {
  const raw = '{"status":"running","note":"contains \\"status\\" substring elsewhere"}';
  assert.equal(parseTerminalSelfReviewSignal(raw), undefined);
});

test('resumable-session probe accepts directory-shaped session paths', () => {
  // grok persists a session DIRECTORY while claude/codex persist files — the
  // probe must be `test -e`; `test -f` silently disables every grok warm resume.
  assert.equal(
    resumableSessionProbeCommand('/home/u/.grok/sessions/repo/abc123'),
    "test -e '/home/u/.grok/sessions/repo/abc123'",
  );
  assert.equal(resumableSessionProbeCommand("/x/it's.jsonl"), "test -e '/x/it'\\''s.jsonl'");
});
