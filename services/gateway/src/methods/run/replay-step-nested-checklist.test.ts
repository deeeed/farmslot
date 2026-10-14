import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import { PipelineSteps as PS } from '@farmslot/protocol';

// mock.module replaces a module wholesale, so a partial namedExports map silently
// deletes every export the subject's import graph still needs. These namespace
// imports are evaluated before mock.module runs, so they hold the REAL modules;
// spreading them keeps every export real and overrides only the fixtures this
// test actually needs. Enumerating exports by hand is what produced the
// missing-export chain (isLocal, resolveSlot, isIgnoredPoolFile, …).
import * as realConfig from '../../core/config.js';
import * as realCoreIndex from '../../core/index.js';
import * as realOrchestrator from '../../run-engine/orchestrator.js';

let workspace = '';
let orchestratorTaskRoot = '';

mock.module('../../core/config.js', {
  namedExports: {
    ...realConfig,
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

// mock.module replaces the module wholesale, so every export the subject's import
// graph reaches must be listed here. methods/diagnostics.ts imports isLocal and
// loadSlotVars from this barrel; omitting them made the file fail to import.
mock.module('../../core/index.js', {
  namedExports: {
    ...realCoreIndex,
    // Keep this test on the successful replay-reclaim path; the synthetic slot
    // is intentionally absent from the real fleet configuration.
    claimSlotStatusIf: async () => ({ claimed: true, epoch: 1 }),
    updateSlotStatusIf: async () => true,
    loadSlotVars: async () => ({
      remoteRepo: workspace,
      host: 'localhost',
      machine: os.hostname(),
      slotId: 'macwork-ff-replay-checklist',
      projectName: 'farmslot-farm',
    }),
  },
});

mock.module('../../run-engine/orchestrator.js', {
  namedExports: {
    ...realOrchestrator,
    cancelRunEngine: () => {},
    bumpRunGeneration: () => {},
    startRun: async () => {},
  },
});

const { runReplayStep } = await import('./replay-step.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../../runs/store.js');
const { CHECKLIST_TARGET_BY_AGENT_ROLE, CHECKLIST_TARGET_MANIFEST } =
  await import('../../tasks/checklist-target.js');
const { resolveWorkerTerminalContract } = await import('../../tasks/worker-terminal-contract.js');

for (const stepName of [PS.MONITOR, PS.REVIEW]) {
  test(`runReplayStep ${stepName} restores frozen dispatch policy without changing evidence`, async (t) => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'replay-nested-checklist-'));
    orchestratorTaskRoot = path.join(workspace, 'orchestrator-tasks');
    const taskRel = 'fix/replay-reset';
    const taskDirOnSlot = path.join(workspace, '.task', taskRel);
    const taskFile = path.join(orchestratorTaskRoot, taskRel, 'TASK.md');

    await mkdir(taskDirOnSlot, { recursive: true });
    await mkdir(path.dirname(taskFile), { recursive: true });
    await writeFile(taskFile, '# worker\n');
    await writeFile(path.join(taskDirOnSlot, 'CHECKLIST.md'), '# checklist\n');

    const review = CHECKLIST_TARGET_BY_AGENT_ROLE['review'];
    await writeFile(path.join(taskDirOnSlot, review.checklist), '# review\n');
    await writeFile(
      path.join(taskDirOnSlot, CHECKLIST_TARGET_MANIFEST),
      `${JSON.stringify({ checklist: review.checklist }, null, 2)}\n`,
    );

    const run = createRun({
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: `PROJ-${Date.now()}`,
    });
    const frozen = JSON.stringify({
      ...resolveWorkerTerminalContract({ acceptance: { require: true } }, run.flowType),
      claimReviewGate: true,
      recordedEvidenceContractVersion: run.recordedEvidenceContractVersion,
      deterministicChecks: [
        {
          checklist: 'CHECKLIST.md',
          stepNumber: 1,
          reference: 'ci.local_check',
          command: 'printf frozen',
        },
      ],
    });
    await mkdir(path.join(path.dirname(taskFile), 'inputs'));
    await writeFile(
      path.join(path.dirname(taskFile), 'inputs/worker-terminal-contract.json'),
      frozen,
    );
    await writeFile(
      path.join(path.dirname(taskFile), 'inputs/handoff.json'),
      JSON.stringify({
        attemptId: run.id,
        project: run.project,
        flow: run.flowType,
      }),
    );
    await mkdir(path.join(taskDirOnSlot, 'inputs'));
    await writeFile(
      path.join(taskDirOnSlot, 'inputs/worker-terminal-contract.json'),
      JSON.stringify(resolveWorkerTerminalContract(null, run.flowType)),
    );
    const retained = {
      recipeRunId: 'retained-recipe',
      claims: [{ id: 'AC-1', verdict: 'awaiting-review' }],
    };
    const evidence = JSON.stringify(retained);
    await writeFile(path.join(taskDirOnSlot, 'retained-evidence.json'), evidence);
    updateRun(run.id, {
      status: 'failed',
      slotId: 'macwork-ff-replay-checklist',
      taskFile,
      steps: run.steps.map((step) => {
        if (['find-slot', 'write-task', 'prepare', 'dispatch', 'monitor'].includes(step.name)) {
          return { ...step, status: 'done' };
        }
        if (step.name === 'review') {
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

    await runReplayStep({ runId: run.id, stepName, triggeredBy: 'operator' }, () => {});

    assert.equal(
      await readFile(path.join(taskDirOnSlot, 'inputs/worker-terminal-contract.json'), 'utf8'),
      frozen,
    );
    assert.equal(
      await readFile(path.join(taskDirOnSlot, 'retained-evidence.json'), 'utf8'),
      evidence,
    );
    assert.equal(
      await readFile(
        path.join(path.dirname(taskFile), 'inputs/worker-terminal-contract.json'),
        'utf8',
      ),
      frozen,
    );

    // Restoring the worker target removes the role switch's manifest: absent
    // means CHECKLIST.md + SIGNAL.json to the mark engine.
    assert.equal(
      existsSync(path.join(taskDirOnSlot, CHECKLIST_TARGET_MANIFEST)),
      stepName === PS.MONITOR,
    );
  });
}
