import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { mergeRunsById } from './gateway-run-sync.js';

function makeRun(id: string, createdAt: string): Run {
  return {
    id,
    familyId: 'family-1',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'done',
    project: 'demo',
    ticketOrPr: id,
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: {
      nudgeCount: 0,
      model: null,
      runner: null,
      runnerSessionId: null,
      runnerSessionPath: null,
      outcome: 'success',
    },
    createdAt,
    updatedAt: createdAt,
  };
}

test('mergeRunsById keeps newest-first order and replaces overlapping ids', () => {
  const existing = [makeRun('a', '2026-06-23T10:00:00.000Z'), makeRun('b', '2026-06-22T10:00:00.000Z')];
  const incoming = [
    { ...makeRun('b', '2026-06-22T10:00:00.000Z'), summary: 'updated' },
    makeRun('c', '2026-06-21T10:00:00.000Z'),
  ];
  const merged = mergeRunsById(existing, incoming);
  assert.deepEqual(
    merged.map((run) => run.id),
    ['a', 'b', 'c'],
  );
  assert.equal(merged.find((run) => run.id === 'b')?.summary, 'updated');
});
