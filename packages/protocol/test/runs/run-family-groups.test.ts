import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '../../src/contracts/runs.js';
import {
  groupRunsByFamily,
  selectRecentRunFamilyGroups,
  sortRunsForFamilyView,
} from '../../src/runs/run-family-groups.js';

function run(overrides: Partial<Run>): Run {
  return {
    id: 'run-a',
    project: 'demo',
    flowType: 'dev',
    status: 'done',
    ticketOrPr: 'PROJ-1',
    branch: 'main',
    slotId: 'runner-mobile-1',
    familyId: 'family-a',
    familyRootTicketOrPr: 'PROJ-1',
    parentRunId: null,
    lane: 'production',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:05:00Z',
    summary: 'Root summary',
    steps: [],
    decisions: [],
    metrics: {},
    links: [],
    ...overrides,
  } as Run;
}

test('sortRunsForFamilyView keeps root first then variants and newest siblings', () => {
  const root = run({ id: 'family-a', parentRunId: null, variant: undefined });
  const bNew = run({
    id: 'run-b-new',
    parentRunId: 'family-a',
    variant: 'b',
    createdAt: '2026-01-03T00:00:00Z',
  });
  const aOld = run({
    id: 'run-a-old',
    parentRunId: 'family-a',
    variant: 'a',
    createdAt: '2026-01-02T00:00:00Z',
  });

  assert.deepEqual(
    sortRunsForFamilyView([bNew, aOld, root]).map((item) => item.id),
    ['family-a', 'run-a-old', 'run-b-new'],
  );
});

test('groupRunsByFamily summarizes family metadata', () => {
  const root = run({ id: 'family-a', familyId: 'family-a', summary: 'Root summary' });
  const followUp = run({
    id: 'run-follow-up',
    familyId: 'family-a',
    parentRunId: 'family-a',
    status: 'monitoring',
    summary: 'Follow-up summary',
    variant: 'fix',
    createdAt: '2026-01-03T00:00:00Z',
    decisions: [
      {
        id: 'retro-pending',
        type: 'retrospective',
        title: 'Pending retro',
        description: 'Review outcome',
        actions: [],
        createdAt: '2026-01-03T00:01:00Z',
      },
      {
        id: 'review-ready',
        type: 'engine_ready_gate',
        title: 'Ready',
        description: 'Ready gate',
        actions: [],
        createdAt: '2026-01-03T00:02:00Z',
      },
    ],
  });
  const standalone = run({
    id: 'standalone',
    familyId: '',
    ticketOrPr: 'PROJ-2',
    summary: 'Standalone summary',
    createdAt: '2026-01-04T00:00:00Z',
  });

  const groups = groupRunsByFamily([root, followUp, standalone]);

  assert.deepEqual(
    groups.map((group) => ({
      familyId: group.familyId,
      project: group.project,
      runs: group.runs.map((item) => item.id),
      activeCount: group.activeCount,
      retrospectives: group.retrospectiveCount,
      pendingRetrospectives: group.pendingRetrospectiveCount,
      variants: group.variants,
    })),
    [
      {
        familyId: 'standalone',
        project: 'demo',
        runs: ['standalone'],
        activeCount: 0,
        retrospectives: 0,
        pendingRetrospectives: 0,
        variants: [],
      },
      {
        familyId: 'family-a',
        project: 'demo',
        runs: ['family-a', 'run-follow-up'],
        activeCount: 1,
        retrospectives: 1,
        pendingRetrospectives: 1,
        variants: ['fix'],
      },
    ],
  );
  assert.equal(groups[1].familySummary, 'Root summary · latest follow-up: Follow-up summary');
});

test('groupRunsByFamily keeps identical family ids separate across projects', () => {
  const mobile = run({
    id: 'mobile-run',
    project: 'mobile',
    familyId: 'shared-family',
    ticketOrPr: 'MOB-1',
    createdAt: '2026-01-03T00:00:00Z',
  });
  const extension = run({
    id: 'extension-run',
    project: 'extension',
    familyId: 'shared-family',
    ticketOrPr: 'EXT-1',
    createdAt: '2026-01-02T00:00:00Z',
  });

  const groups = groupRunsByFamily([extension, mobile]);

  assert.deepEqual(
    groups.map((group) => ({
      familyId: group.familyId,
      project: group.project,
      runs: group.runs.map((item) => item.id),
    })),
    [
      { familyId: 'shared-family', project: 'mobile', runs: ['mobile-run'] },
      { familyId: 'shared-family', project: 'extension', runs: ['extension-run'] },
    ],
  );
});

test('selectRecentRunFamilyGroups returns latest family workspaces for mobile empty states', () => {
  const olderFamily = run({
    id: 'older-root',
    familyId: 'older-family',
    createdAt: '2026-01-01T00:00:00Z',
  });
  const newestFamily = run({
    id: 'newest-root',
    familyId: 'newest-family',
    createdAt: '2026-01-03T00:00:00Z',
  });
  const middleFamily = run({
    id: 'middle-root',
    familyId: 'middle-family',
    createdAt: '2026-01-02T00:00:00Z',
  });

  assert.deepEqual(
    selectRecentRunFamilyGroups([olderFamily, newestFamily, middleFamily], 2).map(
      (group) => group.familyId,
    ),
    ['newest-family', 'middle-family'],
  );
  assert.deepEqual(selectRecentRunFamilyGroups([olderFamily], 0), []);
});

test('groupRunsByFamily orders families by newest activity and counts variants', () => {
  const groups = groupRunsByFamily([
    run({
      id: 'family-a',
      familyId: 'family-a',
      status: 'monitoring',
      createdAt: '2026-04-15T08:00:00.000Z',
    }),
    run({
      id: 'a-claude',
      familyId: 'family-a',
      parentRunId: 'family-a',
      lane: 'comparison',
      variant: 'claude',
      createdAt: '2026-04-15T12:00:00.000Z',
    }),
    run({
      id: 'a-codex',
      familyId: 'family-a',
      parentRunId: 'family-a',
      lane: 'comparison',
      variant: 'codex',
      status: 'monitoring',
      createdAt: '2026-04-15T11:00:00.000Z',
    }),
    run({
      id: 'family-b',
      familyId: 'family-b',
      ticketOrPr: 'PROJ-2',
      familyRootTicketOrPr: 'PROJ-2',
      status: 'failed',
      createdAt: '2026-04-15T09:00:00.000Z',
    }),
  ]);

  assert.deepEqual(
    groups.map((group) => group.familyId),
    ['family-a', 'family-b'],
  );
  assert.equal(groups[0].familyRootTicketOrPr, 'PROJ-1');
  assert.equal(groups[0].rootRun?.id, 'family-a');
  assert.equal(groups[0].activeCount, 2);
  assert.equal(groups[0].comparisonCount, 2);
  assert.deepEqual(groups[0].variants, ['claude', 'codex']);
  assert.deepEqual(
    groups[0].runs.map((item) => item.id),
    ['family-a', 'a-claude', 'a-codex'],
  );
});

test('groupRunsByFamily represents a family by its root, else by its newest run', () => {
  const [rooted] = groupRunsByFamily([
    run({ id: 'fam-root', familyId: 'fam-root', createdAt: '2026-04-15T08:00:00.000Z' }),
    run({
      id: 'cmp-1',
      familyId: 'fam-root',
      parentRunId: 'fam-root',
      lane: 'comparison',
      variant: 'claude',
      summary: 'Variant claude',
      createdAt: '2026-04-15T12:00:00.000Z',
    }),
  ]);
  assert.equal(rooted.representativeRun.id, 'fam-root');
  assert.equal(rooted.familySummary, 'Root summary · latest follow-up: Variant claude');

  const [rootless] = groupRunsByFamily([
    run({
      id: 'cmp-newest',
      familyId: 'fam-cmp',
      parentRunId: 'missing-root',
      lane: 'comparison',
      variant: 'claude',
      summary: 'Cursor variant fix',
      createdAt: '2026-04-15T12:00:00.000Z',
    }),
    run({
      id: 'cmp-older',
      familyId: 'fam-cmp',
      parentRunId: 'missing-root',
      lane: 'comparison',
      variant: 'codex',
      summary: 'Codex variant fix',
      createdAt: '2026-04-15T10:00:00.000Z',
    }),
  ]);
  assert.equal(rootless.rootRun, null);
  assert.equal(rootless.representativeRun.id, 'cmp-newest');
  assert.equal(rootless.familySummary, 'Cursor variant fix');
});

test('groupRunsByFamily counts active runs with the run-list active rule', () => {
  const [group] = groupRunsByFamily([
    run({ id: 'family-a', status: 'blocked' }),
    run({
      id: 'held',
      parentRunId: 'family-a',
      status: 'failed',
      steps: [{ name: 'complete', status: 'failed', outputs: { gatePrerequisiteRefusal: {} } }],
    }),
    run({ id: 'failed', parentRunId: 'family-a', status: 'failed' }),
    run({ id: 'done', parentRunId: 'family-a', status: 'done' }),
  ]);

  assert.equal(group.activeCount, 3);
});
