import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Deferred-resolution gateway stub: each request returns a promise the test
// settles explicitly, so completions can be forced to land after a simulated
// slot switch (generation bump).
type Deferred = { resolve: (value: unknown) => void; reject: (err: Error) => void };
const pending: Deferred[] = [];
mock.module('../../gateway-client.js', {
  namedExports: {
    gateway: {
      request: () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    },
  },
});
mock.module('../../utils/reconnect.js', {
  namedExports: {
    isRecoveryEpochCurrent: () => true,
  },
});

const { loadSlotViewBranchDiff, loadSlotViewBranchList } =
  await import('./slot-view-review-effects.js');

interface FakeView {
  slotId: string;
  _isLive: boolean;
  _recoveryEpoch: number;
  _branchDiffGeneration: number;
  _branchDiffBase: string;
  _branchDiffHead: string;
  _branchDiffFiles: unknown[];
  _branchDiffTotalAdd: number;
  _branchDiffTotalDel: number;
  _branchDiffLoading: boolean;
  _branchDiffError: string | null;
  _branchDiffBranches: string[];
  _git: { branch: string } | null;
  _loadBranchList: () => void;
}

function makeView(): FakeView {
  return {
    slotId: 'slot-a',
    _isLive: true,
    _recoveryEpoch: 7,
    _branchDiffGeneration: 0,
    _branchDiffBase: 'main',
    _branchDiffHead: '',
    _branchDiffFiles: [],
    _branchDiffTotalAdd: 0,
    _branchDiffTotalDel: 0,
    _branchDiffLoading: false,
    _branchDiffError: null,
    _branchDiffBranches: [],
    _git: { branch: 'feat/x' },
    _loadBranchList: () => {},
  };
}

const asView = (view: FakeView) => view as any;

test('stale branch-list success after a slot switch does not write branches', async () => {
  const view = makeView();
  const inFlight = loadSlotViewBranchList(asView(view));
  view._branchDiffGeneration += 1; // simulate A→B (or A→B→A) switch
  pending.shift()?.resolve({ entries: [] });
  await inFlight;
  assert.deepEqual(view._branchDiffBranches, []);
});

test('stale branch-list failure after a slot switch does not clobber branches with the fallback', async () => {
  const view = makeView();
  view._branchDiffBranches = ['main', 'develop', 'feat/current'];
  const inFlight = loadSlotViewBranchList(asView(view));
  view._branchDiffGeneration += 1;
  pending.shift()?.reject(new Error('node reconnecting'));
  await inFlight;
  assert.deepEqual(view._branchDiffBranches, ['main', 'develop', 'feat/current']);
});

test('current branch-list completion writes branches', async () => {
  const view = makeView();
  const inFlight = loadSlotViewBranchList(asView(view));
  pending.shift()?.resolve({ entries: [] });
  await inFlight;
  assert.ok(view._branchDiffBranches.includes('feat/x'));
});

test('stale branch-diff failure after a slot switch does not surface an error or clear files', async () => {
  const view = makeView();
  view._branchDiffFiles = [{ path: 'kept.ts' }];
  const inFlight = loadSlotViewBranchDiff(asView(view));
  view._branchDiffGeneration += 1;
  pending.shift()?.reject(new Error('gateway restart'));
  await inFlight;
  assert.equal(view._branchDiffError, null);
  assert.deepEqual(view._branchDiffFiles, [{ path: 'kept.ts' }]);
});

test('current branch-diff completion writes files and clears the error', async () => {
  const view = makeView();
  view._branchDiffError = 'previous failure';
  const inFlight = loadSlotViewBranchDiff(asView(view));
  pending.shift()?.resolve({
    base: 'main',
    head: 'feat/x',
    files: [{ path: 'a.ts', status: 'M', additions: 1, deletions: 0 }],
    totalAdditions: 1,
    totalDeletions: 0,
  });
  await inFlight;
  assert.equal(view._branchDiffError, null);
  assert.equal(view._branchDiffFiles.length, 1);
  assert.equal(view._branchDiffLoading, false);
});
