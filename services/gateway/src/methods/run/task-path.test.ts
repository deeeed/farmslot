import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';
import { runCreate } from '../run.js';

async function taskDir(checklist: string | null): Promise<{ dir: string; taskFile: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'task-checklist-'));
  const taskFile = path.join(dir, 'TASK.md');
  await writeFile(taskFile, '# task\n');
  if (checklist !== null) await writeFile(path.join(dir, 'CHECKLIST.md'), checklist);
  return { dir, taskFile };
}

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

test('run create refuses a task dir with no CHECKLIST.md before the run exists', async () => {
  const fixture = await taskDir(null);
  try {
    await assert.rejects(
      runCreate(
        {
          flowType: 'dev',
          project: 'example',
          ticketOrPr: 'PROJ-123',
          taskFile: fixture.taskFile,
          executionTemplateId: 'dev/example',
        },
        () => {},
      ),
      /Task dir has no CHECKLIST\.md:.*Use --ticket with --execution-template, or provide CHECKLIST\.md/,
    );
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('run create continues when the task dir already has CHECKLIST.md', async () => {
  const fixture = await taskDir('- [ ] one\n');
  try {
    // The checklist guard is passed. The next check is the sentinel review sequence.
    await assert.rejects(
      runCreate(
        {
          flowType: 'dev',
          project: 'example',
          ticketOrPr: 'PROJ-123',
          taskFile: fixture.taskFile,
          executionTemplateId: 'dev/example',
          reviewSequence: ['not-a-selection'],
        },
        () => {},
      ),
      /Review selection must be an object/,
    );
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});
