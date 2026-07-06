import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTerminalSelfReviewSignal } from './review-agent.js';

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
