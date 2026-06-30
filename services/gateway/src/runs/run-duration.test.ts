import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { runDurationMs } from './run-duration.js';

function makeRun(overrides: Partial<Run>): Run {
  return {
    createdAt: '2026-06-30T00:00:00.000Z',
    metrics: { nudgeCount: 0 },
    steps: [],
    ...overrides,
  } as Run;
}

test('runDurationMs prefers an explicit metrics.durationMs', () => {
  const run = makeRun({ metrics: { nudgeCount: 0, durationMs: 1234 } as Run['metrics'] });
  assert.equal(runDurationMs(run), 1234);
});

test('runDurationMs uses createdAt -> completedAt for terminal runs', () => {
  const run = makeRun({
    createdAt: '2026-06-30T00:00:00.000Z',
    completedAt: '2026-06-30T00:10:00.000Z',
  });
  assert.equal(runDurationMs(run), 600_000);
});

test('runDurationMs falls back to furthest step progress for blocked-at-gate runs', () => {
  const run = makeRun({
    createdAt: '2026-06-30T00:00:00.000Z',
    completedAt: undefined,
    status: 'blocked' as Run['status'],
    steps: [
      { startedAt: '2026-06-30T00:01:00.000Z', completedAt: '2026-06-30T00:02:00.000Z' },
      { startedAt: '2026-06-30T00:05:00.000Z' },
    ] as Run['steps'],
  });
  assert.equal(runDurationMs(run), 300_000);
});

test('runDurationMs returns null when no timestamps resolve', () => {
  const run = makeRun({ createdAt: undefined as unknown as string, completedAt: undefined });
  assert.equal(runDurationMs(run), null);
});
