import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import { PipelineSteps as PS } from '@farmslot/protocol';

let workspace = '';
let orchestratorTaskRoot = '';

mock.module('../../core/config.js', {
  namedExports: {
    DEFAULT_TASK_DIR: '.task',
    loadSlotVars: async () => ({
      remoteRepo: workspace,
      host: 'localhost',
      machine: os.hostname(),
      slotId: 'macwork-ff-replay-checklist',
      projectName: 'farmslot-farm',
    }),
    loadProjectVars: async () => ({ projectJson: {} }),
    getOrchestratorTaskRoot: () => orchestratorTaskRoot,
    resolveProjectTaskDirName: () => '.task',
    resolveTaskRelDir: (taskFile: string, taskRoot: string) => {
      const relativeTaskPath = path.relative(taskRoot, taskFile);
      if (
        relativeTaskPath === '..' ||
        relativeTaskPath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeTaskPath)
      ) {
        return null;
      }
      const relativeTaskDir = path.dirname(relativeTaskPath);
      return relativeTaskDir === '.' ? '' : relativeTaskDir;
    },
  },
});

mock.module('../../core/index.js', {
  namedExports: {
    updateSlotStatusIf: async () => true,
  },
});

mock.module('../../run-engine/orchestrator.js', {
  namedExports: {
    cancelRunEngine: () => {},
    bumpRunGeneration: () => {},
    startRun: async () => {},
  },
});

const { runReplayStep } = await import('./replay-step.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../../runs/store.js');
const { CHECKLIST_TARGET_BY_AGENT_ROLE, CHECKLIST_TARGET_MANIFEST } =
  await import('../../tasks/checklist-target.js');

test('runReplayStep restores worker checklist-target when replaying from self-review', async (t) => {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'replay-nested-checklist-'));
  orchestratorTaskRoot = path.join(workspace, 'orchestrator-tasks');
  const taskRel = 'fix/replay-reset';
  const taskDirOnSlot = path.join(workspace, '.task', taskRel);
  const taskFile = path.join(orchestratorTaskRoot, taskRel, 'TASK.md');

  await mkdir(taskDirOnSlot, { recursive: true });
  await mkdir(path.dirname(taskFile), { recursive: true });
  await writeFile(taskFile, '# worker\n');
  await writeFile(path.join(taskDirOnSlot, 'CHECKLIST.md'), '# checklist\n');

  const selfReview = CHECKLIST_TARGET_BY_AGENT_ROLE['self-review'];
  await writeFile(path.join(taskDirOnSlot, selfReview.checklist), '# review\n');
  await writeFile(
    path.join(taskDirOnSlot, CHECKLIST_TARGET_MANIFEST),
    `${JSON.stringify({ checklist: selfReview.checklist }, null, 2)}\n`,
  );

  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'failed',
    slotId: 'macwork-ff-replay-checklist',
    taskFile,
    steps: run.steps.map((step) => {
      if (['find-slot', 'write-task', 'prepare', 'dispatch', 'monitor'].includes(step.name)) {
        return { ...step, status: 'done' };
      }
      if (step.name === 'self-review') {
        return { ...step, status: 'failed' };
      }
      return step;
    }),
  });

  t.after(async () => {
    await rm(workspace, { recursive: true, force: true });
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep(
    { runId: run.id, stepName: PS.SELF_REVIEW, triggeredBy: 'operator' },
    () => {},
  );

  const manifest = JSON.parse(
    await readFile(path.join(taskDirOnSlot, CHECKLIST_TARGET_MANIFEST), 'utf-8'),
  );
  assert.deepEqual(manifest, { checklist: 'CHECKLIST.md' });
});
