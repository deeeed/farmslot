import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotView } from './slot-view.js';

mock.module('../../gateway-client.js', { namedExports: { gateway: {} } });
mock.module('./slot-view-live-effects.js', {
  namedExports: { loadSlotViewGitFileContent: () => Promise.resolve() },
});
const { syncSlotViewUrlState } = await import('./slot-view-url-effects.js');

test('late slot work cannot overwrite another route or a replacement view', (t) => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const location = { hash: '#runs?run=new-run' };
  const writes: string[] = [];
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: { replaceState: (_state: unknown, _title: string, hash: string) => writes.push(hash) },
  });
  t.after(() => {
    for (const [key, descriptor] of [
      ['location', previousLocation],
      ['history', previousHistory],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const view = {
    slotId: 'runner-1',
    isConnected: true,
    _activeFile: 'new.ts',
  } as unknown as SlotView;
  syncSlotViewUrlState(view);
  assert.deepEqual(writes, []);
  location.hash = '#slot/runner-2';
  syncSlotViewUrlState(view);
  assert.deepEqual(writes, []);
  location.hash = '#slot/runner-1';
  syncSlotViewUrlState({ ...view, isConnected: false } as SlotView);
  assert.deepEqual(writes, []);
  syncSlotViewUrlState(view);
  assert.deepEqual(writes, ['#slot/runner-1?file=new.ts']);
  location.hash = '#slot/runner-1/workspace';
  syncSlotViewUrlState(view);
  assert.equal(writes.at(-1), '#slot/runner-1?file=new.ts');
  assert.equal(writes.length, 2);
});
