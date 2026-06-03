import assert from 'node:assert/strict';
import test from 'node:test';

import { fuzzyFilterSlotViewFiles } from './slot-view-search-model.js';

test('fuzzyFilterSlotViewFiles ranks basename matches before path and fuzzy matches', () => {
  const files = [
    'packages/ui/src/components/button.ts',
    'apps/command-center/ui/src/components/slot-view/slot-view.ts',
    'apps/command-center/ui/src/components/search-panel.ts',
    'README.md',
  ];

  assert.deepEqual(fuzzyFilterSlotViewFiles(files, 'search'), [
    'apps/command-center/ui/src/components/search-panel.ts',
  ]);
  assert.deepEqual(fuzzyFilterSlotViewFiles(files, 'slot'), [
    'apps/command-center/ui/src/components/slot-view/slot-view.ts',
  ]);
});

test('fuzzyFilterSlotViewFiles supports ordered-character fuzzy matches', () => {
  assert.deepEqual(fuzzyFilterSlotViewFiles(['src/slot-view.ts', 'src/app.ts'], 'svw'), [
    'src/slot-view.ts',
  ]);
  assert.deepEqual(fuzzyFilterSlotViewFiles(['src/slot-view.ts'], ''), []);
});
