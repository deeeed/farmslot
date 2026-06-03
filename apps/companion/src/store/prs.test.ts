import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRStatus } from '@farmslot/protocol';

import { usePRStore } from './prs';

function pr(overrides: Partial<PRStatus>): PRStatus {
  return {
    repo: 'owner/repo',
    pr: 1,
    title: 'Example PR',
    branch: 'feature',
    project: 'mobile',
    slot: 'runner-mobile-1',
    recommendation: 'WORKING',
    checkSummary: { total: 0, passed: 0, failed: 0, pending: 0 },
    failedNames: [],
    pendingNames: [],
    anyFailed: false,
    actionableBotComments: [],
    mergeConflict: false,
    merged: false,
    prState: 'OPEN',
    ownedFamily: true,
    ...overrides,
  } as PRStatus;
}

test('PR store replaces existing PR events by repo and number', () => {
  usePRStore.setState({ prs: [], updatedAt: null, loading: false, lastError: null });
  usePRStore.getState().setPRs([pr({ pr: 7, title: 'old' })]);

  usePRStore.getState().upsertPR(pr({ pr: 7, title: 'new', recommendation: 'READY' }));

  assert.deepEqual(
    usePRStore
      .getState()
      .prs.map((item) => ({ pr: item.pr, title: item.title, rec: item.recommendation })),
    [{ pr: 7, title: 'new', rec: 'READY' }],
  );
});

test('PR store appends new PR events without clearing existing cache', () => {
  usePRStore.setState({ prs: [], updatedAt: null, loading: false, lastError: null });
  usePRStore.getState().setPRs([pr({ pr: 1 })]);

  usePRStore.getState().upsertPR(pr({ pr: 2 }));

  assert.deepEqual(
    usePRStore.getState().prs.map((item) => item.pr),
    [1, 2],
  );
});
