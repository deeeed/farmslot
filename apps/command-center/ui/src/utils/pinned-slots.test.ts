import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

import {
  isSlotPinned,
  isWorkspacePinned,
  listPinnedSlots,
  listPinnedWorkspaces,
  pinSlot,
  setPinnedSlotLabel,
  togglePinnedWorkspace,
  unpinSlot,
} from './pinned-slots.js';

const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const values = new Map<string, string>();
const events: Event[] = [];
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { dispatchEvent: (event: Event) => events.push(event) },
});
beforeEach(() => {
  values.clear();
  events.length = 0;
});
after(() => {
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

test('slot and run pins share storage without colliding or losing labels', () => {
  pinSlot('same-id');
  togglePinnedWorkspace({ runId: 'same-id' }, 'Review #42');
  setPinnedSlotLabel('same-id', 'My slot');
  assert.equal(listPinnedWorkspaces().length, 2);
  assert.equal(listPinnedSlots()[0].label, 'My slot');
  assert(isWorkspacePinned({ runId: 'same-id' }));
  unpinSlot('same-id');
  assert(!isSlotPinned('same-id'));
  assert.deepEqual(
    listPinnedWorkspaces().map((pin) => pin.label),
    ['Review #42'],
  );
  togglePinnedWorkspace({ runId: 'same-id' });
  assert.equal(listPinnedWorkspaces().length, 0);
  assert.equal(events.length, 5);
});

test('existing slot preferences load alongside run pins and reject ambiguous targets', () => {
  values.set(
    'farmslot:pinned-slots:v1',
    JSON.stringify([
      { slotId: 'legacy', label: 'Keep me' },
      { runId: 'review' },
      { slotId: 'ambiguous', runId: 'review' },
      { runId: '' },
      { runId: 42 },
    ]),
  );
  assert.deepEqual(listPinnedSlots(), [{ slotId: 'legacy', label: 'Keep me' }]);
  assert.equal(listPinnedWorkspaces().length, 2);
  pinSlot('new');
  assert(isWorkspacePinned({ runId: 'review' }));
});
