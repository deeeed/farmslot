import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  slotViewPinnedFolderCandidates,
  slotViewPinnedFolderFromTaskFile,
  slotViewTaskRelativePath,
} from './slot-view-pinned-model.js';

test('slotViewTaskRelativePath prefers slot agent task file on worker repo', () => {
  assert.equal(
    slotViewTaskRelativePath({
      runTaskFile:
        '/Users/deeeed/dev/farmslot/.sandbox/farmslot-farm/tasks/feat/112-0627-223003/TASK.md',
      slotAgentTaskFile: '.sandbox/farmslot-farm/worker-task/feat/112-0627-223003/TASK.md',
      slotTaskFile: 'fallback-slot-task',
      showTaskUi: true,
    }),
    'feat/112-0627-223003',
  );
});

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

test('slotViewPinnedFolderFromTaskFile returns slot-relative task directory', () => {
  assert.equal(
    slotViewPinnedFolderFromTaskFile('.sandbox/farmslot-farm/worker-task/feat/112-0627-223003/TASK.md'),
    '.sandbox/farmslot-farm/worker-task/feat/112-0627-223003',
  );
});

test('slotViewPinnedFolderCandidates probes sandbox worker-task before legacy paths', () => {
  assert.deepEqual(slotViewPinnedFolderCandidates('PROJ-123'), [
    '.sandbox/farmslot-farm/worker-task/PROJ-123',
    '.sandbox/farmslot-farm/task/PROJ-123',
    'temp/tasks/PROJ-123',
    'tasks/PROJ-123',
    '.task/PROJ-123',
    'temp/.task/PROJ-123',
  ]);
});
