import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  buildFamilyStateSummary,
  buildLatestRunByPrNumber,
  findFamilyStateSummaryForPR,
  findFollowUpParentRun,
  isActiveFamilyRun,
  sortRunsByFreshness,
} from './state.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? 'run-1',
    familyId: overrides.familyId ?? 'family-1',
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? 'PROJ-1',
    lane: overrides.lane ?? 'production',
    variant: overrides.variant ?? null,
    flowType: overrides.flowType ?? 'fix-bug',
    mode: overrides.mode ?? 'interactive',
    status: overrides.status ?? 'done',
    project: overrides.project ?? 'example-mobile-farm',
    ticketOrPr: overrides.ticketOrPr ?? 'PROJ-1',
    app: overrides.app,
    slotId: overrides.slotId ?? null,
    branch: overrides.branch ?? null,
    taskFile: overrides.taskFile ?? null,
    activeTaskFile: overrides.activeTaskFile,
    prNumber: overrides.prNumber,
    steps: overrides.steps ?? [],
    decisions: overrides.decisions ?? [],
    metrics: overrides.metrics ?? {
      nudgeCount: 0,
      model: 'gpt-5.5',
      runner: 'codex',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: overrides.createdAt ?? '2026-04-15T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-15T00:00:00.000Z',
    ticketData: overrides.ticketData,
    grade: overrides.grade,
    humanGrade: overrides.humanGrade,
    links: overrides.links,
    summary: overrides.summary,
    reviewTier: overrides.reviewTier,
    completedAt: overrides.completedAt,
    error: overrides.error,
    monitorState: overrides.monitorState,
  };
}

test('isActiveFamilyRun excludes terminal statuses', () => {
  assert.equal(isActiveFamilyRun(makeRun({ status: 'done' })), false);
  assert.equal(isActiveFamilyRun(makeRun({ status: 'failed' })), false);
  assert.equal(isActiveFamilyRun(makeRun({ status: 'monitoring' })), true);
});

test('sortRunsByFreshness prefers updatedAt then createdAt', () => {
  const sorted = sortRunsByFreshness([
    makeRun({ id: 'older', updatedAt: '2026-04-15T00:00:00.000Z' }),
    makeRun({ id: 'newer', updatedAt: '2026-04-15T01:00:00.000Z' }),
  ]);
  assert.deepEqual(
    sorted.map((run) => run.id),
    ['newer', 'older'],
  );
});

test('buildFamilyStateSummary returns canonical family workflow state', () => {
  const summary = buildFamilyStateSummary([
    makeRun({
      id: 'root',
      familyId: 'family-a',
      familyRootTicketOrPr: 'PROJ-77',
      prNumber: 55,
      status: 'done',
      updatedAt: '2026-04-15T00:00:00.000Z',
    }),
    makeRun({
      id: 'followup',
      familyId: 'family-a',
      familyRootTicketOrPr: 'PROJ-77',
      prNumber: 55,
      status: 'ci-watching',
      updatedAt: '2026-04-15T02:00:00.000Z',
    }),
  ]);

  assert.deepEqual(summary, {
    familyId: 'family-a',
    familyRootTicketOrPr: 'PROJ-77',
    familyRunCount: 2,
    activeRunCount: 1,
    latestRunId: 'followup',
    latestPrNumber: 55,
    workflowState: 'active',
    ownedPrFamily: true,
  });
});

test('buildFamilyStateSummary prefers any-done over a later failed run', () => {
  const summary = buildFamilyStateSummary([
    makeRun({
      id: 'root',
      familyId: 'family-a',
      status: 'done',
      updatedAt: '2026-04-15T00:00:00.000Z',
    }),
    makeRun({
      id: 'failed-run',
      familyId: 'family-a',
      status: 'failed',
      updatedAt: '2026-04-15T02:00:00.000Z',
    }),
  ]);

  assert(summary);
  assert.equal(summary.workflowState, 'complete');
  assert.equal(summary.latestRunId, 'failed-run');
});

test('buildFamilyStateSummary marks all-failed families as failed', () => {
  const summary = buildFamilyStateSummary([
    makeRun({
      id: 'attempt-1',
      familyId: 'family-a',
      status: 'failed',
      updatedAt: '2026-04-15T00:00:00.000Z',
    }),
    makeRun({
      id: 'attempt-2',
      familyId: 'family-a',
      status: 'failed',
      updatedAt: '2026-04-15T02:00:00.000Z',
    }),
  ]);

  assert(summary);
  assert.equal(summary.workflowState, 'failed');
  assert.equal(summary.latestRunId, 'attempt-2');
});

test('buildFamilyStateSummary does not mark standalone review-pr families as owned PR families', () => {
  const summary = buildFamilyStateSummary([
    makeRun({
      id: 'review-root',
      familyId: 'family-pr',
      flowType: 'review-pr',
      ticketOrPr: 'owner/repo#55',
      familyRootTicketOrPr: 'owner/repo#55',
      prNumber: 55,
      status: 'done',
      updatedAt: '2026-04-15T02:00:00.000Z',
    }),
  ]);

  assert(summary);
  assert.equal(summary.ownedPrFamily, false);
});

test('findFamilyStateSummaryForPR resolves full family from a PR-linked run within the same project', () => {
  const summary = findFamilyStateSummaryForPR(
    [
      makeRun({
        id: 'root',
        familyId: 'family-a',
        familyRootTicketOrPr: 'PROJ-77',
        prNumber: 55,
        status: 'done',
        updatedAt: '2026-04-15T00:00:00.000Z',
      }),
      makeRun({
        id: 'followup',
        familyId: 'family-a',
        familyRootTicketOrPr: 'PROJ-77',
        prNumber: 55,
        status: 'done',
        updatedAt: '2026-04-15T03:00:00.000Z',
      }),
      makeRun({ id: 'other', familyId: 'family-b', prNumber: 77 }),
    ],
    { prNumber: 55, project: 'example-mobile-farm' },
  );

  assert(summary);
  assert.equal(summary.familyId, 'family-a');
  assert.equal(summary.workflowState, 'complete');
  assert.equal(summary.familyRunCount, 2);
  assert.equal(summary.latestRunId, 'followup');
});

test('findFamilyStateSummaryForPR does not cross project boundaries for duplicate PR numbers', () => {
  const summary = findFamilyStateSummaryForPR(
    [
      makeRun({
        id: 'mobile-run',
        familyId: 'family-mobile',
        project: 'example-mobile-farm',
        prNumber: 55,
        updatedAt: '2026-04-15T03:00:00.000Z',
      }),
      makeRun({
        id: 'extension-run',
        familyId: 'family-ext',
        project: 'example-browser-farm',
        prNumber: 55,
        updatedAt: '2026-04-15T04:00:00.000Z',
      }),
    ],
    { prNumber: 55, project: 'example-mobile-farm' },
  );

  assert(summary);
  assert.equal(summary.familyId, 'family-mobile');
});

test('buildLatestRunByPrNumber prefers newest runs for each PR number', () => {
  const latest = buildLatestRunByPrNumber([
    makeRun({ id: 'older', prNumber: 55, updatedAt: '2026-04-15T00:00:00.000Z', summary: 'old' }),
    makeRun({ id: 'newer', prNumber: 55, updatedAt: '2026-04-15T02:00:00.000Z', summary: 'new' }),
  ]);

  assert.equal(latest.get(55)?.id, 'newer');
});

test('findFollowUpParentRun prefers fix-bug/dev runs over follow-up runs even when newer', () => {
  const parent = findFollowUpParentRun(
    [
      makeRun({
        id: 'feature',
        flowType: 'dev',
        ticketOrPr: 'PROJ-2802',
        prNumber: 41949,
        taskFile: '/tasks/feat/proj-2802/TASK.md',
        updatedAt: '2026-04-20T00:00:00.000Z',
      }),
      makeRun({
        id: 'older-pr-complete',
        flowType: 'pr-complete',
        ticketOrPr: 'example-org/example-browser#41949',
        prNumber: 41949,
        taskFile: '/tasks/fix/41949/TASK.md',
        updatedAt: '2026-04-28T00:00:00.000Z',
      }),
    ],
    { ticketOrPr: 'example-org/example-browser#41949', prNumber: 41949 },
  );
  assert.equal(parent?.id, 'feature');
});

test('findFollowUpParentRun matches by prNumber when ticketOrPr differs (PROJ-key vs owner/repo#N)', () => {
  const parent = findFollowUpParentRun(
    [
      makeRun({
        id: 'fix',
        flowType: 'fix-bug',
        ticketOrPr: 'PROJ-2802',
        prNumber: 41949,
        taskFile: '/tasks/fix/proj-2802/TASK.md',
      }),
    ],
    { ticketOrPr: 'example-org/example-browser#41949', prNumber: 41949 },
  );
  assert.equal(parent?.id, 'fix');
});

test('findFollowUpParentRun falls back to latest follow-up run when no fix-bug/dev parent exists', () => {
  const parent = findFollowUpParentRun(
    [
      makeRun({
        id: 'review',
        flowType: 'review-pr',
        ticketOrPr: 'owner/repo#1',
        prNumber: 1,
        taskFile: '/tasks/review/1/TASK.md',
        updatedAt: '2026-04-15T00:00:00.000Z',
      }),
      makeRun({
        id: 'later-review',
        flowType: 'review-pr',
        ticketOrPr: 'owner/repo#1',
        prNumber: 1,
        taskFile: '/tasks/review/1b/TASK.md',
        updatedAt: '2026-04-16T00:00:00.000Z',
      }),
    ],
    { ticketOrPr: 'owner/repo#1', prNumber: 1 },
  );
  assert.equal(parent?.id, 'later-review');
});

test('findFollowUpParentRun returns null when no candidate has a taskFile', () => {
  const parent = findFollowUpParentRun(
    [
      makeRun({
        id: 'fix',
        flowType: 'fix-bug',
        ticketOrPr: 'PROJ-1',
        prNumber: 1,
        taskFile: null,
      }),
    ],
    { ticketOrPr: 'PROJ-1', prNumber: 1 },
  );
  assert.equal(parent, null);
});

test('findFollowUpParentRun respects project boundary when project is set', () => {
  const parent = findFollowUpParentRun(
    [
      makeRun({
        id: 'a',
        flowType: 'fix-bug',
        ticketOrPr: 'PROJ-1',
        prNumber: 1,
        project: 'project-a',
        taskFile: '/tasks/fix/a/TASK.md',
      }),
      makeRun({
        id: 'b',
        flowType: 'fix-bug',
        ticketOrPr: 'PROJ-1',
        prNumber: 1,
        project: 'project-b',
        taskFile: '/tasks/fix/b/TASK.md',
      }),
    ],
    { ticketOrPr: 'PROJ-1', prNumber: 1, project: 'project-b' },
  );
  assert.equal(parent?.id, 'b');
});
