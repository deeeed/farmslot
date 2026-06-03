import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  slotViewPinnedFolderCandidates,
  slotViewTaskRelativePath,
} from './slot-view-pinned-model.js';

test('slotViewTaskRelativePath prefers run task files rooted under tasks', () => {
  assert.equal(
    slotViewTaskRelativePath({
      runTaskFile: '/repo/tasks/PROJ-123/TASK.md',
      slotTaskFile: 'fallback-slot-task',
      showTaskUi: true,
    }),
    'PROJ-123',
  );
});

test('slotViewTaskRelativePath falls back to slot task only when task UI is visible', () => {
  assert.equal(
    slotViewTaskRelativePath({
      runTaskFile: '/repo/no-task-file.md',
      slotTaskFile: 'SLOT-456',
      showTaskUi: true,
    }),
    'SLOT-456',
  );
  assert.equal(
    slotViewTaskRelativePath({
      runTaskFile: '/repo/no-task-file.md',
      slotTaskFile: 'SLOT-456',
      showTaskUi: false,
    }),
    null,
  );
});

test('slotViewPinnedFolderCandidates preserves probe order from project task dirs to legacy paths', () => {
  assert.deepEqual(slotViewPinnedFolderCandidates('PROJ-123'), [
    'temp/tasks/PROJ-123',
    'tasks/PROJ-123',
    '.task/PROJ-123',
    'temp/.task/PROJ-123',
  ]);
});
