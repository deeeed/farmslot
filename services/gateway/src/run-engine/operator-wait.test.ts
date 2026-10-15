import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkerSignal } from '@farmslot/protocol';

import { operatorWaitDurationMs } from './operator-wait.js';

test('closed and active operator intervals exclude only time within the monitor execution', () => {
  const signal: WorkerSignal = {
    status: 'running',
    timestamp: '2026-10-15T00:00:20.000Z',
    attemptId: 'owned-attempt',
    operatorWaitIntervals: [
      { since: '2026-10-15T00:00:00.000Z', until: '2026-10-15T00:00:08.000Z' },
    ],
    waitingForOperator: {
      who: 'operator',
      reason: 'approach review',
      since: '2026-10-15T00:00:10.000Z',
    },
  };
  const startedAt = Date.parse('2026-10-15T00:00:05.000Z');
  const now = Date.parse(signal.timestamp!);
  assert.equal(operatorWaitDurationMs(signal, startedAt, now), 13_000);
  assert.equal(
    operatorWaitDurationMs({ ...signal, waitingForOperator: undefined }, startedAt, now),
    3_000,
  );
  assert.equal(operatorWaitDurationMs(signal, now, now), 0);
});
