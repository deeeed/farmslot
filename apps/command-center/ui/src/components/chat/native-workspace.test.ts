import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { NativeWorkspaceChangesResult, NativeWorkspaceDiffResult } from '@farmslot/protocol';

import { FakeControllerHost } from '../../testing/fake-controller-host.js';
import { litText } from '../../testing/lit-text.js';
import { DiffTestFilterController } from '../shared/diff-test-filter-controller.js';

// The viewers load @pierre/diffs, which needs a DOM; the gateway client opens sockets.
mock.module('../diff-viewer/pierre-views.js', { namedExports: {} });
mock.module('../../gateway-client.js', { namedExports: { gateway: {} } });

const { NativeWorkspace } = await import('./native-workspace.js');

/** The private state and methods the tests drive. */
interface Workspace {
  tab: 'files' | 'changes';
  changes?: NativeWorkspaceChangesResult;
  selected: string;
  diff?: NativeWorkspaceDiffResult;
  loading: boolean;
  testFilter: DiffTestFilterController;
  api: { request: (method: string, params?: unknown) => Promise<unknown> };
  openFile(path: string, display: 'source' | 'diff'): Promise<void>;
  openPath(path: string, line?: number): Promise<void>;
  directory: string;
  line: number;
  leaveHiddenFile(): void;
  render(): unknown;
}

const testPath = 'src/greeting.test.ts';
const testDiff: NativeWorkspaceDiffResult = { path: testPath, diff: '+SECRET-TEST-LINE' };

// Built from the prototype so no DOM or render cycle is needed; reactive setters stay inert.
function makeWorkspace(request: Workspace['api']['request']): Workspace {
  const view = Object.create(NativeWorkspace.prototype) as Workspace;
  Object.assign(view, { requestUpdate: () => undefined });
  Object.assign(view, {
    sessionId: 'session-1',
    executionNodeId: 'local',
    tab: 'changes',
    changes: { files: [{ path: testPath, status: 'M' }] },
    selected: '',
    directory: '.',
    display: 'diff',
    error: '',
    loading: false,
    revision: 0,
    api: { request },
    reads: {
      clear() {},
      releaseMethods() {},
      status: '',
      error: '',
      read: async (method: string, params: unknown, apply: (value: unknown) => void) => {
        const value = await request(method, params);
        apply(value);
        return value;
      },
    },
  });
  view.testFilter = new DiffTestFilterController(new FakeControllerHost(), {
    onChange: () => view.leaveHiddenFile(),
  });
  view.testFilter.hideTests = false;
  return view;
}

test('hiding tests while a test diff loads drops the selection and the late response', async () => {
  let resolveDiff: (diff: NativeWorkspaceDiffResult) => void = () => undefined;
  const view = makeWorkspace(
    () =>
      new Promise((resolve) => {
        resolveDiff = resolve;
      }),
  );

  const opening = view.openFile(testPath, 'diff');
  view.testFilter.hideTests = true;
  view.leaveHiddenFile();
  resolveDiff(testDiff);
  await opening;

  assert.equal(view.selected, '');
  assert.equal(view.diff, undefined, 'the stale response is dropped');
  assert.equal(view.loading, false);
  const text = litText(view.render());
  assert.match(text, /Only test files changed/);
  assert.doesNotMatch(text, /SECRET-TEST-LINE/);
});

test('a hidden test diff never renders in Changes mode, however it arrived', () => {
  const view = makeWorkspace(async () => testDiff);
  Object.assign(view, { selected: testPath, diff: testDiff });
  view.testFilter.hideTests = true;

  const text = litText(view.render());
  assert.doesNotMatch(text, /SECRET-TEST-LINE/);
  assert.match(text, /Test file hidden/);
});

test('non-git Changes is a quiet empty state and Files remains a selectable view', () => {
  const view = makeWorkspace(async () => ({ files: [], repository: false }));
  view.changes = { files: [], repository: false };
  const text = litText(view.render());
  assert.match(text, /Not a git repository: no file changes to show/);
  assert.match(text, /Files/);
  assert.doesNotMatch(text, /No workspace changes/);
});

test('a file link opens its file in the Files tab at its line, listing its directory', async () => {
  const requests: { method: string; params: unknown }[] = [];
  const view = makeWorkspace(async (method, params) => {
    requests.push({ method, params });
    return method === 'native.session.workspace.list'
      ? { path: 'src/lib', entries: [{ name: 'app.ts', path: 'src/lib/app.ts', directory: false }] }
      : { path: 'src/lib/app.ts', content: 'line\n'.repeat(50) };
  });

  await view.openPath('src/lib/app.ts', 42);

  assert.equal(view.tab, 'files');
  assert.equal(view.directory, 'src/lib');
  assert.equal(view.selected, 'src/lib/app.ts');
  assert.equal(view.line, 42);
  assert.deepEqual(
    requests.map(({ method, params }) => [method, (params as { path: string }).path]),
    [
      ['native.session.workspace.list', 'src/lib'],
      ['native.session.workspace.read', 'src/lib/app.ts'],
    ],
  );
  // Choosing another file from the list drops the link's line.
  await view.openFile('src/lib/other.ts', 'source');
  assert.equal(view.line, 0);
});
