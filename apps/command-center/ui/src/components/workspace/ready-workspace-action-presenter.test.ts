import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { type GitBranchDiffFile, Methods } from '@farmslot/protocol';

// Gateway stub: branch diffs per slot, and a file diff that names its slot so a
// stale diff from another run is visible in the assertion.
const branchFiles: Record<string, GitBranchDiffFile[]> = {};
const fileDiffRequests: string[] = [];
mock.module('../../gateway-client.js', {
  namedExports: {
    gateway: {
      connectionState: 'connected',
      connectionEpoch: 1,
      onConnectionChange: () => () => undefined,
      request: async (method: string, params: { slotId: string; path?: string }) => {
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
    _hideTests: false,
    _selectedFile: '',
    _fileDiff: '',
    _fileDiffLoading: false,
    ...fields,
  });
  return view;
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

  view._onHideTestsChanged(true);
  assert.equal(view._hideTests, true);
  assert.deepEqual(selected, [codeFile.path]);
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

  view._onHideTestsChanged(true);
  assert.deepEqual(selected, []);

  view._fileDiff = '';
  view._onHideTestsChanged(false);
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

  view._onHideTestsChanged(true);
  view.slotId = 'slot-b';
  await view._loadBranchDiff(1);
  await flush();
  assert.equal(view._selectedFile, '', 'nothing visible: the previous selection is dropped');
  assert.equal(view._fileDiff, '');

  view._onHideTestsChanged(false);
  await flush();
  assert.equal(view._selectedFile, testFile.path);
  assert.equal(view._fileDiff, 'diff from slot-b');
  assert.deepEqual(fileDiffRequests, [`slot-a:${testFile.path}`, `slot-b:${testFile.path}`]);
});
