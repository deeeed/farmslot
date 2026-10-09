import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { NativeWorkspaceChangesResult, NativeWorkspaceDiffResult } from '@farmslot/protocol';

import { FakeControllerHost } from '../../testing/fake-controller-host.js';
import { litText } from '../../testing/lit-text.js';
import { DiffTestFilterController } from '../shared/diff-test-filter-controller.js';

// The viewers pull CSS and Monaco that node can't load; the gateway client opens sockets.
mock.module('../diff-viewer/diff-review.js', { namedExports: {} });
mock.module('../diff-viewer/code-viewer.js', { namedExports: {} });
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
