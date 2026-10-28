import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '../../src/contracts/runs.js';
import {
  matchesRunList,
  type RunListFilter,
  runListPage,
  type RunListProjection,
  runListProjection,
} from '../../src/runs/run-list-filter.js';
import { selectRunList } from '../../src/runs/run-list-view.js';

function run(id: string, fields: Record<string, unknown> = {}): Run {
  return {
    id,
    status: 'done',
    flowType: 'dev',
    project: 'farm',
    ticketOrPr: `T-${id}`,
    familyId: `family-${id}`,
    lane: 'production',
    createdAt: `2026-10-0${id.length}T00:00:00.000Z`,
    updatedAt: '2026-10-28T00:00:00.000Z',
    slotId: null,
    steps: [],
    decisions: [],
    metrics: {},
    ...fields,
  } as unknown as Run;
}

const runs = [
  run('a', { status: 'running', tags: ['Ship', 'ux'], summary: 'Fix the Login page' }),
  run('bb', { status: 'failed', prNumber: 7, metrics: { outcome: 'failure', durationMs: 50 } }),
  run('ccc', { project: 'other', variant: 'v2', lane: 'comparison', flowType: 'review-pr' }),
  run('dddd', {
    status: 'failed',
    archivedAt: '2026-10-20T00:00:00.000Z',
    humanGrade: { recipe_semantic: 'good' },
    metrics: { durationMs: 500 },
    tags: ['ux'],
  }),
  run('eeeee', {
    slotId: 'mini-3',
    ticketData: { source: 'manual', linkedTickets: [{ ref: 'ABC-12' }] },
    metrics: { disposition: 'needs_input' },
  }),
];

/** Expectations written from services/gateway/src/runs/store.ts `listRuns`. */
const cases: Array<[RunListFilter, string[], number?]> = [
  [{}, ['eeeee', 'dddd', 'ccc', 'bb', 'a']],
  [{ status: 'failed' }, ['dddd', 'bb']],
  // `active` keeps nonterminal runs and failures nobody archived; status wins over it.
  [{ active: true }, ['bb', 'a']],
  [{ active: true, status: 'done' }, ['eeeee', 'ccc']],
  [{ flowType: 'review-pr' }, ['ccc']],
  [{ project: 'other' }, ['ccc']],
  [{ prNumber: 7 }, ['bb']],
  [{ familyId: 'family-a' }, ['a']],
  [{ lane: 'comparison' }, ['ccc']],
  [{ variant: 'v2' }, ['ccc']],
  [{ variant: null }, ['eeeee', 'dddd', 'bb', 'a']],
  [{ outcome: 'failure' }, ['bb']],
  [{ dateFrom: '2026-10-03T00:00:00.000Z' }, ['eeeee', 'dddd', 'ccc']],
  [{ dateTo: '2026-10-02T00:00:00.000Z' }, ['bb', 'a']],
  // Search lowercases the query, ticket and summary, but matches tags as stored.
  [{ search: 'LOGIN' }, ['a']],
  [{ search: 't-bb' }, ['bb']],
  [{ search: 'ship' }, []],
  [{ search: 'ux' }, ['dddd', 'a']],
  [{ tags: ['#UX'] }, ['dddd', 'a']],
  [{ tags: ['ux', 'ship'] }, ['a']],
  [{ sort: 'oldest' }, ['a', 'bb', 'ccc', 'dddd', 'eeeee']],
  [{ sort: 'duration' }, ['dddd', 'bb', 'a', 'ccc', 'eeeee']],
  [{ sort: 'grade' }, ['dddd', 'a', 'bb', 'ccc', 'eeeee']],
  [{ limit: 2 }, ['eeeee', 'dddd'], 5],
];

test('run.list filters, search, sort and limit follow the gateway on runs and projections', () => {
  const sets: Array<readonly (Run | RunListProjection)[]> = [runs, runs.map(runListProjection)];
  for (const [filter, expected, total = expected.length] of cases) {
    for (const rows of sets) {
      const page = runListPage(rows, filter);
      assert.deepEqual(
        page.runs.map(({ id }) => id),
        expected,
        JSON.stringify(filter),
      );
      assert.equal(page.totalCount, total, JSON.stringify(filter));
    }
  }
});

test('only the open-ended list pages at 500; active, family, PR and tag lists are whole', () => {
  const many = Array.from({ length: 501 }, (_, index) =>
    run(`r${index}`, { status: 'running', prNumber: 1, tags: ['t'] }),
  );
  assert.equal(runListPage(many, {}).runs.length, 500);
  assert.equal(runListPage(many, {}).totalCount, 501);
  for (const filter of [{ active: true }, { prNumber: 1 }, { tags: ['t'] }])
    assert.equal(runListPage(many, filter).runs.length, 501);
  assert.equal(runListPage(many, { familyId: 'family-r0' }).runs.length, 1);
});

test('version-list parameters are not filters', () => {
  const matches = matchesRunList({ versions: true, ids: ['a'] } as RunListFilter);
  assert.equal(runs.filter(matches).length, runs.length);
});

test('a projection selects exactly as the run it was made from', () => {
  const projections = runs.map(runListProjection);
  const slotMachines = new Map([['mini-3', 'mini']]);
  for (const query of [
    { scope: 'active' as const },
    { scope: 'history' as const },
    { scope: 'all' as const, machines: ['mini'], slotMachines },
    { scope: 'all' as const, search: 'abc-12' },
    { scope: 'all' as const, search: 'needs input' },
    { scope: 'all' as const, search: 'mini-3' },
    { scope: 'all' as const, tag: 'UX', lane: 'production' as const },
    { scope: 'all' as const, projects: ['other'], flow: 'review-pr' as const },
  ]) {
    assert.deepEqual(
      selectRunList(projections, query).map(({ id }) => id),
      selectRunList(runs, query).map(({ id }) => id),
      JSON.stringify(query),
    );
  }
  assert.deepEqual(
    selectRunList(projections, { scope: 'all', search: 'abc-12' }).map(({ id }) => id),
    ['eeeee'],
  );
});
