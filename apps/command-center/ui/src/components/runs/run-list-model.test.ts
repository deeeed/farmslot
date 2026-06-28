import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

import { filterRunList, runGradeColor } from './run-list-model.js';

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    familyId: 'family-a',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'done',
    project: 'project-a',
    ticketOrPr: `BUG-${id}`,
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5', durationMs: 0 },
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:00.000Z',
    ...overrides,
  } as Run;
}

function filter(overrides: Partial<Parameters<typeof filterRunList>[0]> = {}): readonly Run[] {
  return filterRunList({
    familyFilter: '',
    familyRuns: null,
    tagFilter: '',
    tagRuns: null,
    runs: [],
    globalFilters: { projects: [], machines: [] },
    tab: 'all',
    statusFilter: 'all',
    flowFilter: '',
    laneFilter: '',
    searchQuery: '',
    sortBy: 'newest',
    ...overrides,
  });
}

test('runGradeColor maps semantic grades to status colors', () => {
  assert.equal(runGradeColor('good'), colors.statusOk);
  assert.equal(runGradeColor('ok'), colors.statusWarn);
  assert.equal(runGradeColor('bad'), colors.statusFail);
  assert.equal(runGradeColor('unknown'), colors.textMuted);
});

test('filterRunList applies family, project, tab, status, flow, lane, and search filters', () => {
  const matching = run('1', {
    status: 'failed',
    flowType: 'review-pr',
    lane: 'comparison',
    summary: 'Needs operator review',
  });
  const wrongProject = run('2', { project: 'project-b', status: 'failed' });
  const wrongFamily = run('3', { familyId: 'family-b', status: 'failed' });
  const done = run('4', { status: 'done', summary: 'Needs operator review' });

  assert.deepEqual(
    filter({
      runs: [wrongProject],
      familyFilter: 'family-a',
      familyRuns: [matching, wrongFamily, done],
      globalFilters: { projects: ['project-a'], machines: [] },
      tab: 'all',
      statusFilter: 'failed',
      flowFilter: 'review-pr',
      laneFilter: 'comparison',
      searchQuery: 'operator',
    }).map((item) => item.id),
    ['1'],
  );
});

test('filterRunList active and history tabs preserve legacy terminal-status semantics', () => {
  const active = run('active', { status: 'monitoring' });
  const failed = run('failed', { status: 'failed' });
  const done = run('done', { status: 'done' });

  assert.deepEqual(
    filter({ runs: [active, failed, done], tab: 'active', statusFilter: 'done' }).map(
      (item) => item.id,
    ),
    ['active', 'failed'],
  );
  assert.deepEqual(
    filter({ runs: [active, failed, done], tab: 'history' }).map((item) => item.id),
    ['failed', 'done'],
  );
});

test('filterRunList preserves the original run list reference when no filters or sort apply', () => {
  const runs = [run('one'), run('two')];

  assert.equal(filter({ runs }), runs);
});

test('filterRunList sorts by oldest, duration, and grade', () => {
  const low = run('low', {
    createdAt: '2026-05-14T02:00:00.000Z',
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5', durationMs: 10 },
    humanGrade: { recipe_semantic: 'bad' } as Run['humanGrade'],
  });
  const high = run('high', {
    createdAt: '2026-05-14T01:00:00.000Z',
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5', durationMs: 30 },
    humanGrade: { recipe_semantic: 'good' } as Run['humanGrade'],
  });
  const mid = run('mid', {
    createdAt: '2026-05-14T03:00:00.000Z',
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5', durationMs: 20 },
    humanGrade: { recipe_semantic: 'ok' } as Run['humanGrade'],
  });

  assert.deepEqual(
    filter({ runs: [low, high, mid], sortBy: 'oldest' }).map((item) => item.id),
    ['high', 'low', 'mid'],
  );
  assert.deepEqual(
    filter({ runs: [low, high, mid], sortBy: 'duration' }).map((item) => item.id),
    ['high', 'mid', 'low'],
  );
  assert.deepEqual(
    filter({ runs: [low, high, mid], sortBy: 'grade' }).map((item) => item.id),
    ['high', 'mid', 'low'],
  );
});

test('filterRunList applies exact tag filters and includes tags in text search', () => {
  const demo = run('demo', { tags: ['demo', 'launch-review'] });
  const other = run('other', { tags: ['regression'] });

  assert.deepEqual(
    filter({ runs: [demo, other], tagFilter: 'demo' }).map((item) => item.id),
    ['demo'],
  );
  assert.deepEqual(
    filter({ runs: [demo, other], searchQuery: 'launch' }).map((item) => item.id),
    ['demo'],
  );
});
