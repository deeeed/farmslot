import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeControllerHost } from '../../testing/fake-controller-host.js';
import { installFakeGateway } from '../../testing/fake-gateway.js';
import type { WorkspaceReads } from '../workspace/workspace-reads.js';

import type { autoPinSlotViewTaskFolder } from './slot-view-pinned-effects.js';

function fixture(reads: WorkspaceReads): Parameters<typeof autoPinSlotViewTaskFolder>[0] {
  return {
    slotId: 'slot',
    _linkedRun: null,
    _slot: null,
    _shouldShowTaskUI: () => true,
    _agentContexts: () => [
      {
        id: 'dev',
        role: 'dev',
        label: 'Worker',
        status: 'working',
        runId: 'run',
        slotId: 'slot',
        taskFile: 'projects/proof/tasks/test/TASK.md',
      },
    ],
    _autoPinProbedFor: '',
    _pinnedFolder: '',
    _wsError: '',
    _workspaceReads: reads,
    _saveLayout() {},
    _loadPinnedEntries: async () => {},
  };
}

test('a cancelled task-folder probe cannot paint an error in the replacement workspace', async (t) => {
  installFakeGateway(t);
  const { WorkspaceReads } = await import('../workspace/workspace-reads.js');
  const { autoPinSlotViewTaskFolder } = await import('./slot-view-pinned-effects.js');
  const view = fixture(new WorkspaceReads(new FakeControllerHost()));
  let rejectOld!: (error: Error) => void;
  t.mock.method(
    view._workspaceReads,
    'read',
    () =>
      new Promise<never>((_resolve, reject) => {
        rejectOld = reject;
      }),
  );
  const pending = autoPinSlotViewTaskFolder(view);
  view._workspaceReads.clear();
  rejectOld(new Error('Workspace read superseded'));
  await pending;
  assert.equal(view._wsError, '');
  assert.equal(view._pinnedFolder, '');
  assert.equal(view._autoPinProbedFor, '');
});

test('a current task-folder read failure still surfaces', async (t) => {
  installFakeGateway(t);
  const { WorkspaceReads } = await import('../workspace/workspace-reads.js');
  const { autoPinSlotViewTaskFolder } = await import('./slot-view-pinned-effects.js');
  const view = fixture(new WorkspaceReads(new FakeControllerHost()));
  t.mock.method(view._workspaceReads, 'read', () =>
    Promise.reject(new Error('EACCES: permission denied')),
  );
  await autoPinSlotViewTaskFolder(view);
  assert.match(view._wsError, /EACCES/);
});

test('a same-workspace superseded probe cannot cancel its replacement or paint an error', async (t) => {
  installFakeGateway(t);
  const { WorkspaceReads, WorkspaceReadCancelledError } =
    await import('../workspace/workspace-reads.js');
  const { autoPinSlotViewTaskFolder } = await import('./slot-view-pinned-effects.js');
  const view = fixture(new WorkspaceReads(new FakeControllerHost()));
  t.mock.method(view._workspaceReads, 'read', () =>
    Promise.reject(new WorkspaceReadCancelledError()),
  );
  const drop = t.mock.method(view._workspaceReads, 'drop');
  await autoPinSlotViewTaskFolder(view);
  assert.equal(view._wsError, '');
  assert.equal(drop.mock.callCount(), 0, 'The replacing probe still owns its query');
});
