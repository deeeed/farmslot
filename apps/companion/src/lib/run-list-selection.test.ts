import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunListRow } from '@farmslot/protocol';

import { type CompanionRunListQuery, selectCompanionRunList } from './run-list-selection';

function row(id: string, overrides: Partial<RunListRow> = {}): RunListRow {
  return {
    id,
    familyId: id,
    lane: 'production',
    flowType: 'fix-bug',
    status: 'monitoring',
    project: 'demo',
    ticketOrPr: id,
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, runner: null, model: null },
    createdAt: '2026-11-25T00:00:00.000Z',
    updatedAt: '2026-11-25T00:00:00.000Z',
    ...overrides,
  };
}

const query: CompanionRunListQuery = { scope: 'all', flow: '', lane: '', sort: 'newest' };

test('the Runs tab lists product runs before eval runs, as Command Center does', () => {
  const runs = [
    row('eval-new', { lane: 'comparison', variant: 'glm-c3b' }),
    row('product', { createdAt: '2026-11-24T00:00:00.000Z' }),
    row('eval-old', { lane: 'comparison', createdAt: '2026-11-23T00:00:00.000Z' }),
  ];
  assert.deepEqual(
    selectCompanionRunList(runs, query).map((run) => run.id),
    ['product', 'eval-new', 'eval-old'],
  );
  assert.deepEqual(
    selectCompanionRunList(runs, { ...query, sort: 'oldest' }).map((run) => run.id),
    ['product', 'eval-old', 'eval-new'],
  );
  assert.deepEqual(
    selectCompanionRunList(runs, { ...query, lane: 'product' }).map((run) => run.id),
    ['product'],
  );
});
