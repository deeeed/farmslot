import assert from 'node:assert/strict';
import test from 'node:test';

import {
  workerHistoryShowsMessages,
  workerHistorySourceLabel,
} from './worker-session-history-render.js';

test('history renders live and archived transcripts, not degraded sources', () => {
  assert.equal(workerHistoryShowsMessages('transcript'), true);
  assert.equal(workerHistoryShowsMessages('transcript-archive'), true);
  assert.equal(workerHistoryShowsMessages('pane-degraded'), false);
  assert.equal(workerHistoryShowsMessages('unavailable'), false);
});

test('archived source uses a short operator label', () => {
  assert.equal(workerHistorySourceLabel('transcript-archive'), 'archived');
  assert.equal(workerHistorySourceLabel('transcript'), 'transcript');
});
