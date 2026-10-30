import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { withOwnedGatewayOffline } from './owned-gateway-outage.mjs';

/** Real gateway reads, using only the caller's owned run, slot and task folders. */
export async function proveProgressHistory({
  fixture,
  projects,
  runId,
  runFile,
  statusFile,
  observeResources,
  proveSelection,
}) {
  const control = process.env.FARMSLOT_PROGRESS_HISTORY_CONTROL;
  assert([undefined, 'missing', 'retained'].includes(control));
  const statusBytes = await readFile(statusFile);
  const runBytes = await readFile(runFile);
  const run = JSON.parse(runBytes);
  assert.equal(run.id, runId);
  assert.equal(run.slotId, fixture.slotId);
  const successorId = randomUUID();
  const successorFile = path.join(path.dirname(runFile), `${successorId}.json`);
  const taskRel = `dev/progress-history-${successorId}`;
  const retainedDir = path.join(projects, run.project, 'tasks', taskRel);
  const successorDir = path.join(fixture.repo, '.task', `dev/progress-successor-${successorId}`);
  const selectedArtifact = `.task/${taskRel}/artifacts/review-1.md`;
  let actor;
  try {
    await withOwnedGatewayOffline(async () => {
      await mkdir(path.join(retainedDir, 'artifacts'), { recursive: true });
      await mkdir(successorDir, { recursive: true });
      await writeFile(path.join(retainedDir, 'TASK.md'), '# Retained task\n', { flag: 'wx' });
      await writeFile(path.join(retainedDir, 'CHECKLIST.md'), '# Unchecked dispatch template\n');
      await writeFile(
        path.join(retainedDir, 'CHECKLIST.md.worker'),
        '# Old worker\n- [x] **1. retained build**\n- [x] **2. retained proof**\n',
      );
      await writeFile(path.join(retainedDir, 'REVIEW.md'), '# Unchecked review template\n');
      await writeFile(
        path.join(retainedDir, 'REVIEW.md.worker'),
        '# Old reviewer\n- [x] **1. reviewed**\n- [ ] **2. pending**\n',
      );
      await writeFile(
        path.join(retainedDir, 'artifacts/review-1.md'),
        '# Selected old step\n- [x] **1. retained artifact**\n',
      );
      await writeFile(path.join(successorDir, 'TASK.md'), '# Successor task\n');
      await writeFile(
        path.join(successorDir, 'CHECKLIST.md'),
        '# Successor\n- [x] **1. successor-only progress**\n',
      );
      const status = JSON.parse(statusBytes);
      const slot = status.slots.find((row) => row.slot === fixture.slotId);
      assert.equal(slot.current_run_id, runId);
      slot.current_run_id = successorId;
      slot.task_file = path.relative(path.join(fixture.repo, '.task'), successorDir);
      await writeFile(statusFile, JSON.stringify(status));
      const context = {
        id: 'review-1',
        role: 'review',
        status: 'working',
        runId,
        slotId: fixture.slotId,
        taskFile: path.join(fixture.repo, '.task', taskRel, 'REVIEW.md'),
        target: null,
        updatedAt: run.updatedAt,
      };
      await writeFile(
        runFile,
        JSON.stringify({
          ...run,
          status: 'done',
          taskFile: path.join(retainedDir, 'TASK.md'),
          activeTaskFile: undefined,
          agentContexts: [context],
          steps: [
            {
              name: 'review',
              status: 'done',
              outputs: { taskProgressArtifactPath: selectedArtifact },
            },
          ],
        }),
      );
      await writeFile(
        successorFile,
        JSON.stringify({
          ...run,
          id: successorId,
          familyId: successorId,
          taskFile: path.join(successorDir, 'TASK.md'),
        }),
        { flag: 'wx' },
      );
    });
    actor = await observeResources();
    const read = (params) => actor.read('task.progress', { slotId: fixture.slotId, ...params });
    await assert.rejects(
      read({ runId: randomUUID() }),
      (error) => error.code === 'RUN_NOT_FOUND',
      'A missing requested run must fail closed instead of reading its successor',
    );
    if (control === 'missing') assert.fail('The missing-run control unexpectedly succeeded');
    const old = await read({ runId });
    assert.equal(
      old.structured?.totalSteps,
      2,
      'An old run must read its retained worker checklist',
    );
    assert.equal(old.structured?.completedSteps, 2);
    assert(old.markdown.includes('Old worker'));
    if (control === 'retained') assert.fail('The retained-progress control unexpectedly succeeded');
    const role = await read({ runId, contextId: 'review-1' });
    assert.equal(role.contextId, 'review-1');
    assert.equal(role.structured?.completedSteps, 1, 'A retained reviewer keeps its own progress');
    assert.equal(role.structured?.totalSteps, 2);
    assert(role.markdown.includes('Old reviewer'));
    const selected = await read({ runId, taskFile: selectedArtifact });
    assert.equal(
      selected.structured?.completedSteps,
      1,
      'A retained selected-step artifact stays readable',
    );
    assert(selected.markdown.includes('Selected old step'));
    await assert.rejects(
      read({ runId, taskFile: path.join(successorDir, 'CHECKLIST.md') }),
      (error) => error.code === 'NOT_FOUND',
      'An old run cannot read its successor through an explicit file override',
    );
    const successor = await read({ runId: successorId });
    assert.equal(successor.structured?.totalSteps, 1);
    assert(successor.markdown.includes('successor-only progress'));
    return { progressOwnershipIsolated: true, ...(await proveSelection?.()) };
  } finally {
    actor?.close();
    await withOwnedGatewayOffline(async () => {
      await writeFile(runFile, runBytes);
      await writeFile(statusFile, statusBytes);
      await rm(successorFile, { force: true });
      await rm(retainedDir, { recursive: true, force: true });
      await rm(successorDir, { recursive: true, force: true });
      assert.deepEqual(await readFile(runFile), runBytes);
      assert.deepEqual(await readFile(statusFile), statusBytes);
    });
  }
}
