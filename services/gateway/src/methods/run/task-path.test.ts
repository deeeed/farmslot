import assert from 'node:assert/strict';
import test from 'node:test';

import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';
import { runCreate } from '../run.js';

test('new run creation rejects relative task paths with the CLI upgrade order', async () => {
  await assert.rejects(
    runCreate(
      {
        flowType: 'dev',
        project: 'example',
        ticketOrPr: 'PROJ-123',
        taskFile: 'projects/example/tasks/dev/PROJ-123/TASK.md',
      },
      () => {},
    ),
    /taskFile must be an absolute path.*Upgrade.*CLI.*every node.*then.*gateway/,
  );
});

test('stored runs with legacy relative task paths remain readable', async () => {
  const run = createRun({
    flowType: 'dev',
    project: 'example',
    ticketOrPr: 'PROJ-123',
    taskFile: 'projects/example/tasks/dev/PROJ-123/TASK.md',
  });
  try {
    assert.equal(getRun(run.id)?.taskFile, run.taskFile);
  } finally {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  }
});

test('new run creation rejects unreadable absolute task paths before admission', async () => {
  await assert.rejects(
    runCreate(
      {
        flowType: 'dev',
        project: 'example',
        ticketOrPr: 'PROJ-123',
        taskFile: `/tmp/nonexistent-coherence-${Date.now()}/TASK.md`,
      },
      () => {},
    ),
    /taskFile is not a readable file on the gateway/,
  );
});
