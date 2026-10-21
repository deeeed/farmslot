import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { type Run, type RunStep, slotMachineMap } from '@farmslot/protocol';

// Companion's Runs tab list, imported from its app so both lists run against the same runs.
import { selectCompanionRunList } from '../../../../../companion/src/lib/run-list-selection.js';

import { filterRunList } from './run-list-model.js';

const refusedCompletion: RunStep[] = [
  { name: 'complete', status: 'failed', outputs: { gatePrerequisiteRefusal: {} } },
];

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    familyId: id,
    lane: 'production',
    flowType: 'fix-bug',
    status: 'monitoring',
    project: 'mobile-farm',
    ticketOrPr: `TAT-${id}`,
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
    },
    createdAt: '2026-10-16T10:00:00.000Z',
    updatedAt: '2026-10-16T10:00:00.000Z',
    ...overrides,
  };
}

const runs = [
  run('blocked', { status: 'blocked', slotId: 'macwork-mm-1' }),
  run('held', { status: 'failed', slotId: 'macwork-mm-pixel6', steps: refusedCompletion }),
  run('failed', { status: 'failed', slotId: 'mini-mm-2' }),
  run('failed-without-resources', { status: 'failed' }),
  run('archived-failure', { status: 'failed', archivedAt: '2026-10-21T00:00:00Z' }),
  run('done', { status: 'done', slotId: 'macwork-mm-3' }),
  run('cancelled', { status: 'cancelled' }),
  run('created', { status: 'created', project: 'core-farm' }),
  run('review', { status: 'review-failed', flowType: 'review-pr', tags: ['nightly'] }),
  run('demo', { status: 'paused', slotId: 'demo-work-1', lane: 'validation', summary: 'Perps QA' }),
  run('found', {
    status: 'preparing',
    steps: [{ name: 'find-slot', status: 'done', outputs: { selectedSlot: 'mini-ff-4' } }],
  }),
];
const slotMachines = slotMachineMap([
  { slot: 'macwork-mm-1', machine: 'macwork' },
  { slot: 'demo-work-1', machine: 'farmslot-demo' },
]);

interface ListFilters {
  projects?: string[];
  machines?: string[];
  flow?: Run['flowType'];
  lane?: Run['lane'];
  tag?: string;
  search?: string;
}

function commandCenter(scope: 'active' | 'all', filters: ListFilters): string[] {
  return filterRunList({
    familyFilter: '',
    familyRuns: null,
    tagFilter: filters.tag ?? '',
    tagRuns: null,
    runs,
    globalFilters: { projects: filters.projects ?? [], machines: filters.machines ?? [] },
    slotMachines,
    tab: scope,
    statusFilter: 'all',
    flowFilter: filters.flow ?? '',
    laneFilter: filters.lane ?? '',
    searchQuery: filters.search ?? '',
    sortBy: 'newest',
  })
    .map((item) => item.id)
    .sort();
}

function companion(scope: 'active' | 'all', filters: ListFilters): string[] {
  return selectCompanionRunList(runs, {
    scope,
    projects: filters.projects ?? [],
    machines: filters.machines ?? [],
    slotMachines,
    flow: filters.flow ?? '',
    lane: filters.lane ?? '',
    tag: filters.tag ?? '',
    search: filters.search ?? '',
    sort: 'newest',
  })
    .map((item) => item.id)
    .sort();
}

test('Command Center and Companion list the same active runs', () => {
  assert.deepEqual(companion('active', {}), commandCenter('active', {}));
  assert.deepEqual(commandCenter('active', {}), [
    'blocked',
    'created',
    'demo',
    'failed',
    'failed-without-resources',
    'found',
    'held',
    'review',
  ]);
});

test('Command Center and Companion apply the same filters to the run list', () => {
  const cases: ListFilters[] = [
    { projects: ['core-farm'] },
    { machines: ['macwork'] },
    { machines: ['farmslot-demo'] },
    { machines: ['mini'] },
    { flow: 'review-pr' },
    { lane: 'validation' },
    { tag: 'Nightly' },
    { search: 'perps' },
    { search: 'mm-pixel6' },
    { projects: ['mobile-farm'], machines: ['macwork'] },
  ];
  for (const filters of cases) {
    for (const scope of ['active', 'all'] as const) {
      assert.deepEqual(
        companion(scope, filters),
        commandCenter(scope, filters),
        `${scope} ${JSON.stringify(filters)}`,
      );
    }
  }
  assert.deepEqual(commandCenter('active', { machines: ['mini'] }), ['failed', 'found']);
  assert.deepEqual(commandCenter('all', { machines: ['mini'] }), ['failed', 'found']);
});
