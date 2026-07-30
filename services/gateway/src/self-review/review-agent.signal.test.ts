import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseTerminalSelfReviewSignal,
  resumableSessionProbeCommand,
  shouldKeepWaitingForOverdueReview,
} from './review-agent.js';

test('active overdue reviewers remain non-terminal while inactive reviewers may time out', () => {
  assert.equal(shouldKeepWaitingForOverdueReview(true, false), true);
  assert.equal(shouldKeepWaitingForOverdueReview(false, false), false);
  assert.equal(shouldKeepWaitingForOverdueReview(true, true), false);
});

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
