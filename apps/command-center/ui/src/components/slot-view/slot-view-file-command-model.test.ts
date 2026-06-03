import { strict as assert } from 'node:assert';
import test from 'node:test';

import { canSaveSlotViewFile } from './slot-view-file-command-model.js';

test('canSaveSlotViewFile requires live writable file tab', () => {
  assert.equal(
    canSaveSlotViewFile({
      activeFile: 'src/app.ts',
      isLive: true,
      saveFeedback: '',
      recoveryBlocked: false,
      activeTabType: 'file',
    }),
    true,
  );
  assert.equal(
    canSaveSlotViewFile({
      activeFile: '',
      isLive: true,
      saveFeedback: '',
      recoveryBlocked: false,
      activeTabType: 'file',
    }),
    false,
  );
  assert.equal(
    canSaveSlotViewFile({
      activeFile: 'src/app.ts',
      isLive: false,
      saveFeedback: '',
      recoveryBlocked: false,
      activeTabType: 'file',
    }),
    false,
  );
  assert.equal(
    canSaveSlotViewFile({
      activeFile: 'src/app.ts',
      isLive: true,
      saveFeedback: '',
      recoveryBlocked: false,
      activeTabType: 'diff',
    }),
    false,
  );
});

test('canSaveSlotViewFile blocks saving and recovery-blocked states', () => {
  assert.equal(
    canSaveSlotViewFile({
      activeFile: 'src/app.ts',
      isLive: true,
      saveFeedback: 'saving',
      recoveryBlocked: false,
      activeTabType: 'file',
    }),
    false,
  );
  assert.equal(
    canSaveSlotViewFile({
      activeFile: 'src/app.ts',
      isLive: true,
      saveFeedback: '',
      recoveryBlocked: true,
      activeTabType: 'file',
    }),
    false,
  );
});
