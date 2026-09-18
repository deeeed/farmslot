import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveChecklistStepDurations,
  isTerminalWorkerSignal,
  isTerminalWorkerSignalStatus,
} from '../src/transport/signal.js';

test('terminal worker signals are complete, failed, done and blocked; nothing else', () => {
  for (const status of ['complete', 'failed', 'done', 'blocked']) {
    assert.equal(isTerminalWorkerSignalStatus(status), true, status);
  }
  assert.equal(isTerminalWorkerSignal({ status: 'running' }), false);
  // An untyped reader may hand over anything; unknown never counts as finished.
  for (const status of ['started', 'pass', '', undefined, null]) {
    assert.equal(isTerminalWorkerSignalStatus(status), false, String(status));
  }
});

test('deriveChecklistStepDurations orders marks and measures the first step from attempt start', () => {
  assert.deepEqual(
    deriveChecklistStepDurations(
      {
        schemaVersion: 1,
        events: [
          { stepNumber: 2, label: 'second', checkedAt: '2026-08-14T00:00:05.000Z' },
          { stepNumber: 1, label: 'first', checkedAt: '2026-08-14T00:00:02.000Z' },
        ],
      },
      '2026-08-14T00:00:00.000Z',
    ),
    [
      { stepNumber: 1, label: 'first', durationMs: 2_000 },
      { stepNumber: 2, label: 'second', durationMs: 3_000 },
    ],
  );
});

test('deriveChecklistStepDurations keeps the legacy zero first duration without a start time', () => {
  assert.deepEqual(
    deriveChecklistStepDurations({
      schemaVersion: 1,
      events: [{ stepNumber: 1, label: 'first', checkedAt: '2026-08-14T00:00:02.000Z' }],
    }),
    [{ stepNumber: 1, label: 'first', durationMs: 0 }],
  );
});
