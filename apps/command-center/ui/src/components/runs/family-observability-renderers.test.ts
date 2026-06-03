import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRStatus, RelatedRunSummary } from '@farmslot/protocol';

import { relatedFamiliesForDisplay } from './family-observability-renderers.js';

function relatedRun(overrides: Partial<RelatedRunSummary> = {}): RelatedRunSummary {
  return {
    runId: 'run-1',
    familyId: 'family-a',
    flowType: 'fix-bug',
    status: 'done',
    project: 'farmslot',
    ticketOrPr: 'PROJ-1',
    branch: 'fix/proj-1',
    prNumber: null,
    summary: 'Related run',
    createdAt: '2026-05-14T12:00:00.000Z',
    updatedAt: '2026-05-14T12:30:00.000Z',
    ...overrides,
  };
}

function prStatus(overrides: Partial<PRStatus> = {}): PRStatus {
  return {
    pr: 101,
    title: 'PR title',
    summary: null,
    repo: 'owner/repo',
    headRef: 'fix/proj-1',
    project: 'farmslot',
    slot: null,
    session: null,
    checks: [],
    checkSummary: { passed: 0, failed: 0, pending: 0, total: 0 },
    allPassed: true,
    anyFailed: false,
    failedNames: [],
    botComments: [],
    actionableBotComments: [],
    prState: 'OPEN',
    merged: false,
    mergeable: 'UNKNOWN',
    mergeConflict: false,
    reviewDecision: '',
    recommendation: 'READY',
    ...overrides,
  };
}

test('relatedFamiliesForDisplay groups by family and sorts each family newest first', () => {
  const groups = relatedFamiliesForDisplay(
    [
      relatedRun({
        runId: 'older-a',
        familyId: 'family-a',
        createdAt: '2026-05-14T10:00:00.000Z',
        prNumber: 101,
      }),
      relatedRun({
        runId: 'newer-b',
        familyId: 'family-b',
        createdAt: '2026-05-14T12:00:00.000Z',
      }),
      relatedRun({
        runId: 'newer-a',
        familyId: 'family-a',
        createdAt: '2026-05-14T11:00:00.000Z',
        prNumber: 101,
      }),
    ],
    [prStatus({ pr: 101, prState: 'MERGED' })],
  );

  assert.deepEqual(
    groups.map((group) => group.familyId),
    ['family-b', 'family-a'],
  );
  assert.deepEqual(
    groups.find((group) => group.familyId === 'family-a')?.runs.map((run) => run.runId),
    ['newer-a', 'older-a'],
  );
  assert.deepEqual(groups.find((group) => group.familyId === 'family-a')?.prNumbers, [101]);
  assert.equal(
    groups.find((group) => group.familyId === 'family-a')?.prRecords[0]?.prState,
    'MERGED',
  );
});
