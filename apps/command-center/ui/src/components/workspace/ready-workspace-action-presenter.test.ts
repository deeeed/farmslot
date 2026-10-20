import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { type GitBranchDiffFile, Methods, type RunDecision } from '@farmslot/protocol';

import { FakeControllerHost } from '../../testing/fake-controller-host.js';
import { DiffTestFilterController } from '../shared/diff-test-filter-controller.js';

// Gateway stub: branch diffs per slot, and a file diff that names its slot so a
// stale diff from another run is visible in the assertion.
const branchFiles: Record<string, GitBranchDiffFile[]> = {};
const fileDiffRequests: string[] = [];
// Decision submission: the reply to run.resolveDecision, and the run a later run.get reads.
let resolveReply: () => Promise<unknown> = async () => ({});
let gatewayDecision: { id: string; resolvedAt?: string; resolvedAction?: string } = { id: 'gate' };
mock.module('../../gateway-client.js', {
  namedExports: {
    gateway: {
      connectionState: 'connected',
      connectionEpoch: 1,
      onConnectionChange: () => () => undefined,
      request: async (method: string, params: { slotId: string; path?: string }) => {
        if (method === Methods.RUN_RESOLVE_DECISION) return resolveReply();
        if (method === Methods.RUN_GET) return { run: { decisions: [gatewayDecision] } };
        if (method === Methods.GIT_BRANCH_DIFF) return { files: branchFiles[params.slotId] ?? [] };
        fileDiffRequests.push(`${params.slotId}:${params.path}`);
        return { diff: `diff from ${params.slotId}` };
      },
    },
  },
});

// The import graph reads `location` at module load (global filters).
Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: new URL('http://localhost/'),
});

const { ReadyWorkspaceActionPresenter } = await import('./ready-workspace-action-presenter.js');
const { GatewayRequestTimeoutError } = await import('../../gateway-request-timeout.js');

type Presenter = InstanceType<typeof ReadyWorkspaceActionPresenter>;

// The presenter is a LitElement; build it from the prototype so no DOM or
// render cycle is needed, and keep reactive setters and the hash write inert.
function makePresenter(fields: Partial<Presenter> = {}): Presenter {
  const view = Object.create(ReadyWorkspaceActionPresenter.prototype) as Presenter;
  Object.assign(view, {
    requestUpdate: () => undefined,
    _syncViewStateToHash: () => undefined,
    slotId: 'slot-a',
    _recoveryEpoch: 1,
    _diffFiles: [],
    _selectedFile: '',
    _fileDiff: '',
    _fileDiffLoading: false,
    ...fields,
  });
  // Field initializers do not run on a prototype-built view; wire the filter
  // the way the presenter does.
  Object.assign(view, {
    _testFilter: new DiffTestFilterController(new FakeControllerHost(), {
      patterns: () => view._diffTestPatterns,
      onChange: () => view._onHideTestsChanged(),
    }),
  });
  return view;
}

/** What the preference subscription does on a flip. */
function setHideTests(view: Presenter, hide: boolean): void {
  view._testFilter.hideTests = hide;
  view._onHideTestsChanged();
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const testFile = { path: 'src/gate.test.ts', status: 'M', additions: 3, deletions: 0 } as const;
const codeFile = { path: 'src/gate.ts', status: 'M', additions: 2, deletions: 1 } as const;

test('hiding tests hands a selected test file to the first visible file', () => {
  const selected: string[] = [];
  const view = makePresenter({
    _diffFiles: [testFile, codeFile],
    _selectedFile: testFile.path,
    _fileDiff: 'test diff',
  });
  view._selectFile = async (path: string) => {
    selected.push(path);
  };

  setHideTests(view, true);
  assert.deepEqual(selected, [codeFile.path]);
});

test('hiding tests when only tests changed drops the open test file and its diff', () => {
  const view = makePresenter({
    _diffFiles: [testFile],
    _selectedFile: testFile.path,
    _fileDiff: 'test diff',
  });
  view._selectFile = async () => {
    assert.fail('nothing is listed, so nothing is selected');
  };

  setHideTests(view, true);
  assert.equal(view._selectedFile, '');
  assert.equal(view._fileDiff, '');
});

test('a pref flip keeps a loaded visible selection and refetches one without a diff', () => {
  const selected: string[] = [];
  const view = makePresenter({
    _diffFiles: [testFile, codeFile],
    _selectedFile: codeFile.path,
    _fileDiff: 'code diff',
  });
  view._selectFile = async (path: string) => {
    selected.push(path);
  };

  setHideTests(view, true);
  assert.deepEqual(selected, []);

  view._fileDiff = '';
  setHideTests(view, false);
  assert.deepEqual(selected, [codeFile.path]);
});

test('showing tests after a hidden reload fetches the new run diff for the same path', async () => {
  branchFiles['slot-a'] = [testFile];
  branchFiles['slot-b'] = [testFile];
  fileDiffRequests.length = 0;
  const view = makePresenter();

  await view._loadBranchDiff(1);
  await flush();
  assert.equal(view._fileDiff, 'diff from slot-a');

  setHideTests(view, true);
  view.slotId = 'slot-b';
  await view._loadBranchDiff(1);
  await flush();
  assert.equal(view._selectedFile, '', 'nothing visible: the previous selection is dropped');
  assert.equal(view._fileDiff, '');

  setHideTests(view, false);
  await flush();
  assert.equal(view._selectedFile, testFile.path);
  assert.equal(view._fileDiff, 'diff from slot-b');
  assert.deepEqual(fileDiffRequests, [`slot-a:${testFile.path}`, `slot-b:${testFile.path}`]);
});

// TAT-4145 bda11b1a gate 5bc9ef11: the approval took longer than 15 s to validate, the gateway
// applied it at 05:47:32Z, and the person was told it failed.
function submittingPresenter(): Presenter {
  const decision: RunDecision = {
    id: 'gate',
    type: 'engine_human_gate',
    title: 'Gate',
    description: '',
    actions: [],
    createdAt: '2026-10-20T05:40:28.065Z',
  };
  return makePresenter({ runId: 'run-a', decision, _recoveryPhase: 'live' });
}
const timedOut = async (): Promise<never> => {
  throw new GatewayRequestTimeoutError('Request run.resolveDecision timed out after 120000ms');
};

test('a decision the gateway applied after the reply timed out reads as submitted', async () => {
  resolveReply = timedOut;
  gatewayDecision = { id: 'gate', resolvedAt: '2026-10-20T05:47:32.163Z', resolvedAction: 'hold' };
  const view = submittingPresenter();
  await view._resolve('hold');
  assert.equal(view._actionTone, 'success');
  assert.doesNotMatch(view._actionMessage, /Failed/);
});

test('a decision not yet applied when the reply timed out is not reported as failed', async () => {
  resolveReply = timedOut;
  gatewayDecision = { id: 'gate' };
  const view = submittingPresenter();
  await view._resolve('hold');
  assert.notEqual(view._actionTone, 'error');
  assert.doesNotMatch(view._actionMessage, /Failed/);
  assert.match(view._actionMessage, /not confirmed this decision yet/);
  assert.equal(view._acting, false);
});

test('a refused decision still reads as failed', async () => {
  resolveReply = async () => {
    throw new Error('Decision already resolved');
  };
  gatewayDecision = { id: 'gate' };
  const view = submittingPresenter();
  await view._resolve('hold');
  assert.equal(view._actionTone, 'error');
  assert.equal(view._actionMessage, 'Failed to submit decision: Decision already resolved');
});
