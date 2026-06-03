import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  selectSingleActiveRunForSlot,
  SKIP_ACTIVE_RUN_SELECTION,
  sortActiveRunsNewestFirst,
} from './active-run-selection.js';

function fakeRun(overrides: Partial<Run> & { id: string; slotId?: string | null }): Run {
  const base = {
    slotId: 'slot-a',
    createdAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T00:00:00.000Z',
    flowType: 'fix-bug',
    project: 'demo',
    status: 'running',
    ticketOrPr: 'PROJ-001',
    metrics: {},
    steps: [],
  };
  return { ...base, ...overrides } as Run;
}

test('selectSingleActiveRunForSlot returns the only candidate when unambiguous', () => {
  const run = fakeRun({ id: 'r1' });
  const got = selectSingleActiveRunForSlot('slot-a', [run], { onAmbiguous: 'throw' });
  assert.equal(got, run);
});

test('selectSingleActiveRunForSlot returns null when no candidates match the slot', () => {
  const run = fakeRun({ id: 'r1', slotId: 'slot-b' });
  const got = selectSingleActiveRunForSlot('slot-a', [run], { onAmbiguous: 'throw' });
  assert.equal(got, null);
});

test('selectSingleActiveRunForSlot honors currentRunId pointer', () => {
  const r1 = fakeRun({ id: 'r1', createdAt: '2026-04-27T00:00:00.000Z' });
  const r2 = fakeRun({ id: 'r2', createdAt: '2026-04-27T01:00:00.000Z' });
  const got = selectSingleActiveRunForSlot('slot-a', [r1, r2], {
    currentRunId: 'r1',
    onAmbiguous: 'throw',
  });
  assert.equal(got, r1);
});

test('selectSingleActiveRunForSlot honors requestedRunId over currentRunId', () => {
  const r1 = fakeRun({ id: 'r1' });
  const r2 = fakeRun({ id: 'r2' });
  const got = selectSingleActiveRunForSlot('slot-a', [r1, r2], {
    requestedRunId: 'r2',
    currentRunId: 'r1',
    onAmbiguous: 'throw',
  });
  assert.equal(got, r2);
});

test('selectSingleActiveRunForSlot throws on ambiguity when policy is throw', () => {
  const r1 = fakeRun({ id: 'r1' });
  const r2 = fakeRun({ id: 'r2', createdAt: '2026-04-27T01:00:00.000Z' });
  assert.throws(
    () => selectSingleActiveRunForSlot('slot-a', [r1, r2], { onAmbiguous: 'throw' }),
    /multiple active runs.*refusing to guess/,
  );
});

test('selectSingleActiveRunForSlot returns null on ambiguity when policy is warn-null', () => {
  const r1 = fakeRun({ id: 'r1' });
  const r2 = fakeRun({ id: 'r2', createdAt: '2026-04-27T01:00:00.000Z' });
  const got = selectSingleActiveRunForSlot('slot-a', [r1, r2], { onAmbiguous: 'warn-null' });
  assert.equal(got, null);
});

test('selectSingleActiveRunForSlot returns SKIP sentinel on ambiguity when policy is warn-skip', () => {
  const r1 = fakeRun({ id: 'r1' });
  const r2 = fakeRun({ id: 'r2', createdAt: '2026-04-27T01:00:00.000Z' });
  const got = selectSingleActiveRunForSlot('slot-a', [r1, r2], { onAmbiguous: 'warn-skip' });
  assert.equal(got, SKIP_ACTIVE_RUN_SELECTION);
});

test('selectSingleActiveRunForSlot fallback ignores stale currentRunId and falls through', () => {
  const r1 = fakeRun({ id: 'r1' });
  const got = selectSingleActiveRunForSlot('slot-a', [r1], {
    currentRunId: 'missing-run',
    onAmbiguous: 'throw',
    onMissingPointer: 'fallback',
  });
  assert.equal(got, r1);
});

test('selectSingleActiveRunForSlot fallback + ambiguity uses ambiguity policy', () => {
  const r1 = fakeRun({ id: 'r1' });
  const r2 = fakeRun({ id: 'r2', createdAt: '2026-04-27T01:00:00.000Z' });
  assert.throws(
    () =>
      selectSingleActiveRunForSlot('slot-a', [r1, r2], {
        currentRunId: 'missing',
        onAmbiguous: 'throw',
        onMissingPointer: 'fallback',
      }),
    /multiple active runs/,
  );
});

test('selectSingleActiveRunForSlot warn-null on missing pointer returns null without falling through', () => {
  const r1 = fakeRun({ id: 'r1' });
  const got = selectSingleActiveRunForSlot('slot-a', [r1], {
    currentRunId: 'missing',
    onAmbiguous: 'throw',
    onMissingPointer: 'warn-null',
  });
  assert.equal(got, null);
});

test('selectSingleActiveRunForSlot warn-skip on requestedRunId wrong-slot returns SKIP', () => {
  const r1 = fakeRun({ id: 'r1', slotId: 'slot-b' });
  const got = selectSingleActiveRunForSlot('slot-a', [r1], {
    requestedRunId: 'r1',
    onAmbiguous: 'throw',
    onMissingPointer: 'warn-skip',
  });
  assert.equal(got, SKIP_ACTIVE_RUN_SELECTION);
});

test('sortActiveRunsNewestFirst sorts by createdAt desc with id tiebreak', () => {
  const a = fakeRun({
    id: 'r-a',
    createdAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T00:00:00.000Z',
  });
  const b = fakeRun({
    id: 'r-b',
    createdAt: '2026-04-27T01:00:00.000Z',
    updatedAt: '2026-04-27T01:00:00.000Z',
  });
  const c = fakeRun({
    id: 'r-c',
    createdAt: '2026-04-27T01:00:00.000Z',
    updatedAt: '2026-04-27T01:00:00.000Z',
  });
  const sorted = sortActiveRunsNewestFirst([a, b, c]);
  assert.deepEqual(
    sorted.map((r) => r.id),
    ['r-c', 'r-b', 'r-a'],
  );
});
