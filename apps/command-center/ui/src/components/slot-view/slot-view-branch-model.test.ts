import assert from 'node:assert/strict';
import test from 'node:test';

import {
  branchDiffPollAction,
  gitChangesFingerprint,
  isBranchDiffTicketCurrent,
  slotViewBranchList,
} from './slot-view-branch-model.js';

test('slotViewBranchList includes default and active branch candidates', () => {
  assert.deepEqual(
    slotViewBranchList({
      branchDiffBase: 'origin/main',
      branchDiffHead: 'feature/ui-cleanup',
      gitBranch: 'feature/worktree',
    }),
    ['develop', 'feature/ui-cleanup', 'feature/worktree', 'main', 'origin/main'],
  );
});

test('slotViewBranchList deduplicates main and empty candidates', () => {
  assert.deepEqual(
    slotViewBranchList({ branchDiffBase: 'main', branchDiffHead: '', gitBranch: undefined }),
    ['develop', 'main'],
  );
});

const POLL_BASE = {
  prevBranch: 'feat/x' as string | undefined,
  nextBranch: 'feat/x',
  prevAhead: 2 as number | undefined,
  nextAhead: 2,
  prevChangesKey: '' as string | undefined,
  nextChangesKey: '',
  lastLoadFailed: false,
  loading: false,
};

test('branchDiffPollAction reloads and clears the cache when the working tree changes', () => {
  assert.equal(
    branchDiffPollAction({
      ...POLL_BASE,
      prevChangesKey: 'a.ts:M:0',
      nextChangesKey: 'a.ts:M:0|b.ts:A:0',
    }),
    'reload-and-clear-cache',
  );
});

test('branchDiffPollAction keeps reloading the list while the worktree stays dirty', () => {
  // Same status fingerprint, but an already-modified file may have new edits
  // the fingerprint cannot see — list refresh only, cache stays.
  assert.equal(
    branchDiffPollAction({
      ...POLL_BASE,
      prevChangesKey: 'a.ts:M:0',
      nextChangesKey: 'a.ts:M:0',
    }),
    'reload',
  );
});

test('gitChangesFingerprint is order-independent and state-sensitive', () => {
  assert.equal(
    gitChangesFingerprint([
      { path: 'b.ts', status: 'A', staged: false },
      { path: 'a.ts', status: 'M', staged: true },
    ]),
    gitChangesFingerprint([
      { path: 'a.ts', status: 'M', staged: true },
      { path: 'b.ts', status: 'A', staged: false },
    ]),
  );
  assert.notEqual(
    gitChangesFingerprint([{ path: 'a.ts', status: 'M', staged: true }]),
    gitChangesFingerprint([{ path: 'a.ts', status: 'M', staged: false }]),
  );
});

test('branchDiffPollAction reloads and clears the diff cache on branch change', () => {
  assert.equal(
    branchDiffPollAction({ ...POLL_BASE, nextBranch: 'feat/y' }),
    'reload-and-clear-cache',
  );
});

test('branchDiffPollAction reloads and clears the diff cache when ahead changes', () => {
  assert.equal(branchDiffPollAction({ ...POLL_BASE, nextAhead: 6 }), 'reload-and-clear-cache');
});

test('branchDiffPollAction retries without clearing the cache after a failed load', () => {
  assert.equal(branchDiffPollAction({ ...POLL_BASE, lastLoadFailed: true }), 'reload');
});

test('branchDiffPollAction stays idle while a load is in flight', () => {
  assert.equal(
    branchDiffPollAction({ ...POLL_BASE, lastLoadFailed: true, nextAhead: 6, loading: true }),
    'none',
  );
});

test('branchDiffPollAction stays idle when nothing changed and last load succeeded', () => {
  assert.equal(branchDiffPollAction(POLL_BASE), 'none');
});

test('branchDiffPollAction does not treat the first poll as git movement', () => {
  assert.equal(
    branchDiffPollAction({
      ...POLL_BASE,
      prevBranch: undefined,
      prevAhead: undefined,
      prevChangesKey: undefined,
    }),
    'none',
  );
});

test('isBranchDiffTicketCurrent stales tickets across A-to-B-to-A navigation', () => {
  // Visit A (generation 0): request starts.
  const staleTicket = { generation: 0, epoch: 7 };
  // Switch A->B (gen 1), then B->A (gen 2): same slot id as the original
  // visit, but the ticket must still be stale.
  assert.equal(
    isBranchDiffTicketCurrent(staleTicket, { generation: 2, epoch: 7, epochCurrent: true }),
    false,
  );
  // A request issued during the current visit is valid.
  assert.equal(
    isBranchDiffTicketCurrent(
      { generation: 2, epoch: 7 },
      { generation: 2, epoch: 7, epochCurrent: true },
    ),
    true,
  );
});

test('isBranchDiffTicketCurrent stales tickets across gateway reconnects', () => {
  assert.equal(
    isBranchDiffTicketCurrent(
      { generation: 3, epoch: 7 },
      { generation: 3, epoch: 8, epochCurrent: false },
    ),
    false,
  );
});
