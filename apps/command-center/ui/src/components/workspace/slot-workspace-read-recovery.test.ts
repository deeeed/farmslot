import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { LitElement } from 'lit';

import { installFakeGateway } from '../../testing/fake-gateway.js';

mock.module('./file-tree.js', { namedExports: {} });
mock.module('./git-changes.js', { namedExports: {} });
mock.module('./tab-bar.js', { namedExports: {} });

test('a retired pending workspace read cannot paint an error or finish the new load', async (t) => {
  installFakeGateway(t);
  const { SlotWorkspace } = await import('./slot-workspace.js');
  assert.ok(SlotWorkspace.prototype instanceof LitElement);
  const view = new SlotWorkspace();
  view.slotId = 'first-slot';
  let rejectOld!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, reject) => {
    rejectOld = reject;
  });
  const read = t.mock.method(view['reads'], 'read', () => pending);
  const first = view['_initLive']();
  read.mock.mockImplementation(() => new Promise<never>(() => {}));
  view.slotId = 'next-slot';
  void view['_initLive']();
  rejectOld(new Error('Workspace read superseded'));
  await first;
  assert.equal(view['_error'], '');
  assert.equal(view['_loading'], true);
  view['_teardownLive']();
});
