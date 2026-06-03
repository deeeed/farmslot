import assert from 'node:assert/strict';
import test from 'node:test';

import type { FileEntry } from '../workspace/file-tree.js';

import { updateSlotViewTreeChildren } from './slot-view-tree-model.js';

test('updateSlotViewTreeChildren replaces root entries', () => {
  const children: FileEntry[] = [{ name: 'src', path: 'src', type: 'directory' }];

  assert.deepEqual(updateSlotViewTreeChildren([], '.', children), children);
});

test('updateSlotViewTreeChildren updates nested directory children without mutating siblings', () => {
  const entries: FileEntry[] = [
    {
      name: 'src',
      path: 'src',
      type: 'directory',
      children: [
        { name: 'old.ts', path: 'src/old.ts', type: 'file' },
        { name: 'lib', path: 'src/lib', type: 'directory', children: [] },
      ],
    },
    { name: 'README.md', path: 'README.md', type: 'file' },
  ];
  const children: FileEntry[] = [{ name: 'new.ts', path: 'src/lib/new.ts', type: 'file' }];

  const next = updateSlotViewTreeChildren(entries, 'src/lib', children);

  assert.notEqual(next, entries);
  assert.equal(next[1], entries[1]);
  assert.deepEqual(next[0]?.children?.[1], {
    name: 'lib',
    path: 'src/lib',
    type: 'directory',
    children,
  });
  assert.deepEqual(entries[0]?.children?.[1], {
    name: 'lib',
    path: 'src/lib',
    type: 'directory',
    children: [],
  });
});
