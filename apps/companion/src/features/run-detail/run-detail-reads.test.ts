import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResourceQueryState } from '@farmslot/protocol/client-cache';

import { resourceReadMessages } from '../../lib/resource-read-status';

import { retryRunDetailReads, runDetailReadObservations } from './run-detail-reads';

const now = Date.parse('2026-11-02T12:00:00.000Z');
const minutes = (count: number) => now - count * 60_000;

/** Saved data read `age` minutes ago, offline. */
const saved = (age: number): ResourceQueryState => ({
  status: 'stale',
  data: {},
  observedAt: minutes(age),
});
const ready: ResourceQueryState = { status: 'ready', data: {}, observedAt: now };

function messages(fromList: boolean, runObservation: ResourceQueryState, connected = false) {
  const reads = runDetailReadObservations({
    fromList,
    listObservation: saved(5),
    runObservation,
    evidenceObservation: ready,
  });
  return resourceReadMessages(reads, now, connected, false);
}

test('a list row on screen is dated from the run list, once', () => {
  assert.deepEqual(messages(true, saved(120)), ['Saved run · 5m old']);
});

test("a list row on screen still reports run.get's errors", () => {
  const failed: ResourceQueryState = {
    ...saved(120),
    error: { code: 'READ_FAILED', message: 'Request run.get timed out' },
  };
  assert.deepEqual(messages(true, failed, true), ['Could not read run: Request run.get timed out']);
});

test("run.get's own run on screen is dated from run.get", () => {
  assert.deepEqual(messages(false, saved(120)), ['Saved run · 2h old']);
});

test('Retry rereads the run list only when the row on screen came from a failed list read', async () => {
  const failedList: ResourceQueryState = {
    ...saved(5),
    error: { code: 'READ_FAILED', message: 'offline' },
  };
  for (const [fromList, listObservation, listRetried] of [
    [true, failedList, true],
    [true, saved(5), false],
    [false, failedList, false],
  ] as const) {
    const calls: string[] = [];
    await retryRunDetailReads({
      fromList,
      listObservation,
      retryList: async () => {
        calls.push('list');
      },
      retryReads: async () => {
        calls.push('reads');
      },
    });
    assert.deepEqual(calls.sort(), listRetried ? ['list', 'reads'] : ['reads']);
  }
});
