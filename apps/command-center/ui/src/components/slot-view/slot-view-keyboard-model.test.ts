import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  slotViewKeyboardAction,
  type SlotViewKeyboardDecisionInput,
} from './slot-view-keyboard-model.js';

const base: SlotViewKeyboardDecisionInput = {
  key: '',
  code: '',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  inTerminal: false,
  inEditable: false,
  hasSlotId: true,
  modalOpen: false,
  slotSwitcherCount: 2,
  newFilePrompt: false,
};

test('slotViewKeyboardAction preserves global save and sidebar shortcuts', () => {
  assert.deepEqual(slotViewKeyboardAction({ ...base, metaKey: true, key: 'b' }), {
    kind: 'toggle-sidebar',
  });
  assert.deepEqual(slotViewKeyboardAction({ ...base, ctrlKey: true, key: 's' }), {
    kind: 'save-file',
  });
  assert.deepEqual(slotViewKeyboardAction({ ...base, ctrlKey: true, key: 's', inTerminal: true }), {
    kind: 'none',
  });
});

test('slotViewKeyboardAction keeps resource panel shortcut out of editable contexts', () => {
  assert.deepEqual(slotViewKeyboardAction({ ...base, metaKey: true, shiftKey: true, key: 'S' }), {
    kind: 'toggle-resource-panel',
  });
  assert.deepEqual(
    slotViewKeyboardAction({ ...base, metaKey: true, shiftKey: true, key: 'S', inEditable: true }),
    { kind: 'none' },
  );
});

test('slotViewKeyboardAction gates relative slot switching like the component did', () => {
  assert.deepEqual(slotViewKeyboardAction({ ...base, altKey: true, code: 'BracketLeft' }), {
    kind: 'switch-relative-slot',
    direction: -1,
  });
  assert.deepEqual(slotViewKeyboardAction({ ...base, altKey: true, code: 'BracketRight' }), {
    kind: 'switch-relative-slot',
    direction: 1,
  });
  assert.deepEqual(
    slotViewKeyboardAction({ ...base, altKey: true, code: 'BracketRight', modalOpen: true }),
    { kind: 'none' },
  );
  assert.deepEqual(
    slotViewKeyboardAction({ ...base, altKey: true, code: 'BracketRight', slotSwitcherCount: 1 }),
    { kind: 'none' },
  );
});

test('slotViewKeyboardAction closes new file prompt on escape', () => {
  assert.deepEqual(slotViewKeyboardAction({ ...base, key: 'Escape', newFilePrompt: true }), {
    kind: 'close-new-file-prompt',
  });
});
