import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResourceQueryState } from '../../src/client-cache/types.js';
import type { Run } from '../../src/contracts/runs.js';
import type { RunListResult } from '../../src/rpc/run.js';
import { mergeRunListObservations } from '../../src/runs/run-list-observation.js';

function snapshot(
  status: ResourceQueryState['status'],
  runs: Run[],
  observedAt: number,
): ResourceQueryState<RunListResult> {
  return { status, data: { runs, totalCount: runs.length }, observedAt };
}
function row(id: string, status: Run['status'], updatedAt: string): Run {
  return {
    id,
    familyId: id,
    parentRunId: null,
    familyRootTicketOrPr: id,
    lane: 'production',
    variant: null,
    flowType: 'dev',
    mode: 'interactive',
    project: 'farm',
    ticketOrPr: id,
    status,
    slotId: null,
    taskFile: null,
    branch: null,
    steps: [],
    decisions: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt,
    metrics: { runner: null, model: null, nudgeCount: 0 },
  };
}

test('an active/history list keeps newer row facts even when the other response arrives later', () => {
  const newest = row('same', 'done', '2026-01-03T00:00:00Z');
  const result = mergeRunListObservations(
    snapshot('stale', [row('same', 'monitoring', '2026-01-02T00:00:00Z')], 300),
    snapshot('ready', [newest], 200),
  );
  assert.equal(result.data?.runs[0], newest);
  assert.equal(result.status, 'stale');
  assert.equal(result.observedAt, 200);
});

test('one ready snapshot cannot make a still-loading or failed sibling current', () => {
  const active = snapshot('ready', [row('active', 'monitoring', '2026-01-02T00:00:00Z')], 200);
  assert.equal(mergeRunListObservations(active, { status: 'loading' }).status, 'stale');
  const failed = mergeRunListObservations(active, {
    status: 'error',
    error: { code: 'READ_FAILED', message: 'Unavailable' },
  });
  assert.equal(failed.status, 'stale');
  assert.equal(failed.error?.message, 'Unavailable');
});

test('ready snapshots remove rows absent from both new results rather than retaining a local union', () => {
  const initial = mergeRunListObservations(
    snapshot('ready', [], 1),
    snapshot('ready', [row('deleted', 'done', '2026-01-02T00:00:00Z')], 1),
  );
  assert.equal(initial.data?.runs.length, 1);
  const current = mergeRunListObservations(snapshot('ready', [], 2), snapshot('ready', [], 2));
  assert.equal(current.status, 'ready');
  assert.deepEqual(current.data?.runs, []);
});

test('active-only clients need not fetch history before their list is ready', () => {
  assert.equal(mergeRunListObservations(snapshot('ready', [], 10)).status, 'ready');
});

test('an unsupported gateway remains visible as unsupported even when it supplies row data', () => {
  const result = mergeRunListObservations(
    snapshot('unsupported', [row('r', 'done', '2026-01-02T00:00:00Z')], 10),
  );
  assert.equal(result.status, 'unsupported');
  assert.equal(result.data?.runs.length, 1);
});
