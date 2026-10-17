import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isActiveListRun,
  isCompletionPrerequisiteFailure,
  type Run,
  type RunStep,
} from '../../src/contracts/runs.js';
import { mergeRunsById, selectRunList, slotMachineMap } from '../../src/runs/run-list-view.js';

function makeRun(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    familyId: 'family-1',
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
    metrics: {
      nudgeCount: 0,
      model: null,
      runner: null,
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: '2026-06-23T10:00:00.000Z',
    updatedAt: '2026-06-23T10:00:00.000Z',
    ...overrides,
  };
}

const refusedCompletion: RunStep[] = [
  { name: 'complete', status: 'failed', outputs: { gatePrerequisiteRefusal: {} } },
];

const ids = (runs: readonly Run[]) => runs.map((run) => run.id);

test('only a failed completion prerequisite retains ownership; replay and close release that fence', () => {
  assert.equal(
    isCompletionPrerequisiteFailure({ status: 'failed', steps: refusedCompletion }),
    true,
  );
  for (const status of ['done', 'cancelled', 'completing'] as const)
    assert.equal(isCompletionPrerequisiteFailure({ status, steps: refusedCompletion }), false);
  assert.equal(
    isCompletionPrerequisiteFailure({
      status: 'failed',
      steps: [{ name: 'monitor', status: 'failed' }],
    }),
    false,
  );
  assert.equal(
    isCompletionPrerequisiteFailure({
      status: 'failed',
      steps: [{ name: 'complete', status: 'failed' }],
    }),
    false,
  );
});

test('active runs are nonterminal runs plus failed runs that still hold resources', () => {
  for (const status of ['created', 'monitoring', 'review-failed', 'paused', 'blocked'] as const)
    assert.equal(isActiveListRun({ status }), true, status);
  for (const status of ['done', 'failed', 'cancelled'] as const)
    assert.equal(isActiveListRun({ status }), false, status);
  assert.equal(isActiveListRun({ status: 'failed', steps: refusedCompletion }), true);
});

test('selectRunList scopes keep input order', () => {
  const runs = [
    makeRun('blocked', { status: 'blocked' }),
    makeRun('held', { status: 'failed', steps: refusedCompletion }),
    makeRun('failed', { status: 'failed' }),
    makeRun('done', { status: 'done' }),
  ];

  assert.deepEqual(ids(selectRunList(runs, { scope: 'active' })), ['blocked', 'held']);
  assert.deepEqual(ids(selectRunList(runs, { scope: 'history' })), ['held', 'failed', 'done']);
  assert.deepEqual(ids(selectRunList(runs, { scope: 'all' })), [
    'blocked',
    'held',
    'failed',
    'done',
  ]);
});

test('selectRunList machine filter reads the fleet slot machine, then the slot id prefix', () => {
  const runs = [
    makeRun('demo', { slotId: 'demo-work-1' }),
    makeRun('local', { slotId: 'runner-local-mobile-6' }),
    makeRun('other', { slotId: 'runner-a-mm-2' }),
    makeRun('found', {
      steps: [
        { name: 'find-slot', status: 'done', outputs: { selectedSlot: 'runner-local-ff-4' } },
      ],
    }),
    makeRun('unslotted'),
  ];
  const slotMachines = slotMachineMap([{ slot: 'demo-work-1', machine: 'farmslot-demo' }]);

  assert.deepEqual(
    ids(selectRunList(runs, { scope: 'all', machines: ['farmslot-demo'], slotMachines })),
    ['demo'],
  );
  assert.deepEqual(
    ids(selectRunList(runs, { scope: 'all', machines: ['runner-local'], slotMachines })),
    ['local', 'found'],
  );
});

test('selectRunList applies project, status, flow, lane, tag and search filters together', () => {
  const match = makeRun('match', {
    project: 'farm-a',
    status: 'failed',
    flowType: 'review-pr',
    lane: 'comparison',
    tags: ['Nightly'],
    summary: 'Needs operator review',
  });
  const runs = [
    match,
    makeRun('project', { ...match, id: 'project', project: 'farm-b' }),
    makeRun('status', { ...match, id: 'status', status: 'done' }),
    makeRun('flow', { ...match, id: 'flow', flowType: 'dev' }),
    makeRun('lane', { ...match, id: 'lane', lane: 'production' }),
    makeRun('tag', { ...match, id: 'tag', tags: [] }),
    makeRun('search', { ...match, id: 'search', summary: 'Other' }),
  ];

  assert.deepEqual(
    ids(
      selectRunList(runs, {
        scope: 'all',
        projects: ['farm-a'],
        status: 'failed',
        flow: 'review-pr',
        lane: 'comparison',
        tag: '#nightly',
        search: ' OPERATOR ',
      }),
    ),
    ['match'],
  );
});

test('selectRunList search reads ref, summary, tags, slot and disposition', () => {
  const runs = [
    makeRun('ref', { ticketOrPr: 'TAT-4138' }),
    makeRun('slot', { slotId: 'macwork-mm-4' }),
    makeRun('tag', { tags: ['perps'] }),
    makeRun('disposition', {
      metrics: { ...makeRun('x').metrics, disposition: 'not_reproducible' },
    }),
  ];

  for (const [search, expected] of [
    ['tat-4138', 'ref'],
    ['mm-4', 'slot'],
    ['perp', 'tag'],
    ['not reproducible', 'disposition'],
  ] as const)
    assert.deepEqual(ids(selectRunList(runs, { scope: 'all', search })), [expected], search);
});

test('mergeRunsById keeps newest-first order and replaces overlapping ids', () => {
  const existing = [
    makeRun('a', { createdAt: '2026-06-23T10:00:00.000Z' }),
    makeRun('b', { createdAt: '2026-06-22T10:00:00.000Z' }),
  ];
  const incoming = [
    makeRun('b', { createdAt: '2026-06-22T10:00:00.000Z', summary: 'updated' }),
    makeRun('c', { createdAt: '2026-06-21T10:00:00.000Z' }),
  ];
  const merged = mergeRunsById(existing, incoming);

  assert.deepEqual(ids(merged), ['a', 'b', 'c']);
  assert.equal(merged.find((run) => run.id === 'b')?.summary, 'updated');
});
