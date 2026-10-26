import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Deferred shared-query port: force canonical completions after a slot-generation change.
type Deferred = { resolve: (value: unknown) => void; reject: (err: Error) => void };
const pending: Deferred[] = [];
mock.module('../../gateway-client.js', {
  namedExports: {
    gateway: {
      request: () => assert.fail('Branch views must use the shared workspace query port'),
    },
  },
});
mock.module('../../utils/reconnect.js', {
  namedExports: {
    isRecoveryEpochCurrent: () => true,
  },
});

// Shared-cache port: the test delivers each observed state the way the cache would.
interface ObservedState {
  status: 'loading' | 'ready' | 'stale' | 'error' | 'unsupported';
  data?: unknown;
  observedAt?: number;
}
class FakeQueryController {
  static all: FakeQueryController[] = [];
  state: ObservedState = { status: 'loading' };
  query?: { method: string; params: unknown };
  readonly belongsToWorkspace = true;
  constructor(
    _host: unknown,
    private readonly onChange?: (state: ObservedState) => void,
  ) {
    FakeQueryController.all.push(this);
  }
  setQuery(query?: { method: string; params: unknown }) {
    this.query = query;
  }
  publish(state: ObservedState) {
    this.state = state;
    this.onChange?.(state);
  }
}
mock.module('../shared/resource-query-controller.js', {
  namedExports: { ResourceQueryController: FakeQueryController },
});

const { detectSlotViewPR, loadSlotViewBranchDiff, loadSlotViewBranchList } =
  await import('./slot-view-review-effects.js');

class DeferredWorkspaceReads {
  private adopt?: (value: unknown) => void;
  read<T>(_method: string, _params: unknown, apply: (value: T) => void): Promise<T> {
    this.adopt = (value) => apply(value as T);
    return new Promise((resolve, reject) => {
      pending.push({
        resolve: (value) => {
          this.adopt?.(value);
          resolve(value as T);
        },
        reject,
      });
    });
  }
  publish(value: unknown): void {
    this.adopt?.(value);
  }
}

interface FakeView {
  _workspaceReads: DeferredWorkspaceReads;
  slotId: string;
  _isLive: boolean;
  _recoveryEpoch: number;
  _branchDiffGeneration: number;
  _branchDiffBase: string;
  _branchDiffHead: string;
  _branchDiffFiles: unknown[];
  _branchDiffTestPatterns: readonly string[] | null;
  _branchDiffTotalAdd: number;
  _branchDiffTotalDel: number;
  _branchDiffLoading: boolean;
  _branchDiffError: string | null;
  _branchDiffBranches: string[];
  _liveGitData: { branch: string; headSha: string; ahead: number; behind: number; changes: [] };
  _liveDiffContents: Map<string, string>;
  _git: { branch: string } | null;
  _loadBranchList: () => void;
  _loadBranchDiff: () => void;
  branchDiffReloads: number;
}

function makeView(): FakeView {
  return {
    _workspaceReads: new DeferredWorkspaceReads(),
    slotId: 'slot-a',
    _isLive: true,
    _recoveryEpoch: 7,
    _branchDiffGeneration: 0,
    _branchDiffBase: 'main',
    _branchDiffHead: '',
    _branchDiffFiles: [],
    _branchDiffTestPatterns: null,
    _branchDiffTotalAdd: 0,
    _branchDiffTotalDel: 0,
    _branchDiffLoading: false,
    _branchDiffError: null,
    _branchDiffBranches: [],
    _liveGitData: { branch: 'feat/x', headSha: 'head-a', ahead: 1, behind: 0, changes: [] },
    _liveDiffContents: new Map(),
    _git: { branch: 'feat/x' },
    _loadBranchList: () => {},
    _loadBranchDiff() {
      this.branchDiffReloads += 1;
    },
    branchDiffReloads: 0,
  };
}

const asView = (view: FakeView) => view as any;

test('branch choices use the observed range and status without an independent request', async () => {
  const view = makeView();
  view._branchDiffBase = 'release/base';
  view._branchDiffHead = 'release/head';
  await loadSlotViewBranchList(asView(view));
  assert.deepEqual(view._branchDiffBranches, [
    'develop',
    'feat/x',
    'main',
    'release/base',
    'release/head',
  ]);
  assert.equal(pending.length, 0);
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

test('stale canonical success after a slot switch cannot replace the current files', async () => {
  const view = makeView();
  view._branchDiffFiles = [{ path: 'current.ts' }];
  const inFlight = loadSlotViewBranchDiff(asView(view));
  view._branchDiffGeneration++;
  pending.shift()?.resolve({
    base: 'main',
    head: 'old-head',
    files: [{ path: 'old.ts' }],
    totalAdditions: 1,
    totalDeletions: 0,
  });
  await inFlight;
  assert.deepEqual(view._branchDiffFiles, [{ path: 'current.ts' }]);
});

test('current branch-diff completion writes files and clears the error', async () => {
  const view = makeView();
  view._branchDiffError = 'previous failure';
  const inFlight = loadSlotViewBranchDiff(asView(view));
  pending.shift()?.resolve({
    base: 'main',
    head: 'feat/x',
    files: [{ path: 'a.ts', status: 'M', additions: 1, deletions: 0, kind: 'code' }],
    totalAdditions: 1,
    totalDeletions: 0,
    testFilePatterns: ['*.test.*', '*.check.ts'],
  });
  await inFlight;
  assert.equal(view._branchDiffError, null);
  assert.equal(view._branchDiffFiles.length, 1);
  assert.deepEqual(view._branchDiffTestPatterns, ['*.test.*', '*.check.ts']);
  assert.equal(view._branchDiffLoading, false);
});

test('a later canonical branch snapshot updates the view without a manual reload', async () => {
  const view = makeView();
  const inFlight = loadSlotViewBranchDiff(asView(view));
  pending.shift()?.resolve({
    base: 'main',
    head: 'head-a',
    files: [{ path: 'a.ts', status: 'M', additions: 1, deletions: 0 }],
    totalAdditions: 1,
    totalDeletions: 0,
  });
  await inFlight;
  view._workspaceReads.publish({
    base: 'main',
    head: 'head-b',
    files: [{ path: 'b.ts', status: 'M', additions: 2, deletions: 1 }],
    totalAdditions: 2,
    totalDeletions: 1,
  });
  assert.equal(view._branchDiffHead, 'head-b');
  assert.deepEqual(view._branchDiffFiles, [
    { path: 'b.ts', status: 'M', additions: 2, deletions: 1 },
  ]);
  assert.equal(view._branchDiffTotalAdd, 2);
  assert.equal(view.branchDiffReloads, 0);
});

function slotPR(view: FakeView) {
  return [...FakeQueryController.all]
    .reverse()
    .find(
      (controller) =>
        controller.query?.method === 'pr.forSlot' &&
        (controller.query.params as { slotId: string }).slotId === view.slotId,
    )!;
}

function makePRView() {
  return Object.assign(makeView(), {
    _prNumber: null as number | null,
    _prRepo: null as string | null,
    _prThreads: [] as unknown[],
    _prCurrentUser: '',
    _prCommentsLoading: false,
  });
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('recovery takes the diff base from a current PR answer, never a hydrated saved row', async () => {
  const view = makePRView();
  const recovering = detectSlotViewPR(asView(view));
  const forSlot = slotPR(view);
  // A return visit paints the saved row before the network read.
  forSlot.publish({
    status: 'stale',
    data: { pr: 7, repo: 'org/app', baseRef: 'develop' },
    observedAt: 1,
  });
  await turn();
  assert.equal(view._branchDiffBase, 'main', 'the saved base is not adopted');
  assert.equal(view._prNumber, 7);
  forSlot.publish({
    status: 'ready',
    data: { pr: 11, repo: 'org/app', baseRef: 'release' },
    observedAt: Date.now(),
  });
  await recovering;
  assert.equal(view._branchDiffBase, 'release');
  assert.equal(view._prNumber, 11);

  view._branchDiffBase = 'operator-choice';
  forSlot.publish({
    status: 'ready',
    data: { pr: 12, repo: 'org/app', baseRef: 'hotfix' },
    observedAt: Date.now(),
  });
  assert.equal(view._branchDiffBase, 'operator-choice', 'a later PR update keeps the chosen base');
  assert.equal(view._prNumber, 12);
});

test('a slot switch recovers the new slot base from its own current answer', async () => {
  const view = makePRView();
  view.slotId = 'slot-old';
  const first = detectSlotViewPR(asView(view));
  view.slotId = 'slot-new';
  view._branchDiffBase = 'main';
  const second = detectSlotViewPR(asView(view));
  const forSlot = slotPR(view);
  forSlot.publish({
    status: 'stale',
    data: { pr: 3, repo: 'org/app', baseRef: 'develop' },
    observedAt: 1,
  });
  await turn();
  assert.equal(view._branchDiffBase, 'main');
  // An uncovered network reply is still current for this recovery.
  forSlot.publish({
    status: 'stale',
    data: { pr: 4, repo: 'org/app', baseRef: 'release' },
    observedAt: Date.now(),
  });
  await Promise.all([first, second]);
  assert.equal(view._branchDiffBase, 'release');
  assert.equal(view._prNumber, 4);
});
