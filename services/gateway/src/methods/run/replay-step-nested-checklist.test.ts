import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import * as realOutput from '../../run-completion/output.js';
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

mock.module('../../run-completion/output.js', {
  namedExports: { ...realOutput, captureRunOutput: async () => 0 },
});

const { runReplayStep } = await import('./replay-step.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../../runs/store.js');
const { CHECKLIST_TARGET_BY_AGENT_ROLE, CHECKLIST_TARGET_MANIFEST } =
  await import('../../tasks/checklist-target.js');
const { resolveWorkerTerminalContract } = await import('../../tasks/worker-terminal-contract.js');
const { buildHandoffMetadata, ensureTaskRuntime } = await import('@farmslot/agent-runtime');

for (const stepName of [PS.MONITOR, PS.REVIEW, PS.HUMAN_GATE]) {
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
    const fix = CHECKLIST_TARGET_BY_AGENT_ROLE['review-fix'];
    const fixChecklist = '# fix\n- [x] Current CI receipt\n';
    const fixSignal = JSON.stringify({ status: 'complete', attemptId: 'retained-fix' });
    await writeFile(path.join(taskDirOnSlot, fix.checklist), fixChecklist);
    await writeFile(path.join(taskDirOnSlot, fix.signal), fixSignal);
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
      stepName !== PS.REVIEW,
    );
    if (stepName === PS.HUMAN_GATE) {
      assert.equal(await readFile(path.join(taskDirOnSlot, fix.checklist), 'utf8'), fixChecklist);
      assert.equal(await readFile(path.join(taskDirOnSlot, fix.signal), 'utf8'), fixSignal);
    }
  });
}

for (const authored of [false, true]) {
  test(`monitor replay preserves ${authored ? 'task-init' : 'bare'} adopted-task metadata on a current run`, async (t) => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'replay-authored-task-'));
    orchestratorTaskRoot = path.join(workspace, 'orchestrator-tasks');
    const taskFile = path.join(orchestratorTaskRoot, 'retained', 'TASK.md');
    const workerTask = path.join(workspace, '.task', 'retained');
    await mkdir(path.dirname(taskFile), { recursive: true });
    const text = '# Authored task\n- [x] Retained work\n';
    await writeFile(taskFile, text);
    const run = createRun({
      flowType: 'dev',
      project: 'farmslot-farm',
      taskFile,
      ticketOrPr: `PROJ-${Date.now()}`,
    });
    t.after(async () => {
      await rm(workspace, { recursive: true, force: true });
      if (getRun(run.id)) {
        updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(run.id);
      }
    });
    {
      const terminalContract = {
        ...resolveWorkerTerminalContract(null, run.flowType),
        deterministicChecks: [
          {
            checklist: 'CHECKLIST.md',
            stepNumber: 1,
            reference: 'ci.local_check',
            command: 'printf authored',
          },
        ],
      };
      await ensureTaskRuntime({
        taskDir: path.dirname(taskFile),
        checklistMarkdown: '# Authored checklist\n- [x] Retained work\n',
        terminalContract,
        handoff: buildHandoffMetadata({
          attemptId: authored ? 'authored-task-identity' : run.id,
          surface: authored ? 'recipe-cook' : 'farmslot',
          project: run.project,
          flow: run.flowType,
          title: 'Authored task',
          sourceKind: 'text',
          terminalContract,
        }),
      });
    }
    // Author legacy fixtures through the shared SDK; monitor replay must not initialize or upgrade them.
    const contract = await readFile(
      path.join(path.dirname(taskFile), 'inputs/worker-terminal-contract.json'),
      'utf8',
    );
    const handoff = await readFile(
      path.join(path.dirname(taskFile), 'inputs/handoff.json'),
      'utf8',
    );
    assert.equal(JSON.parse(contract).recordedEvidenceContractVersion, undefined);
    if (authored) assert.equal(JSON.parse(handoff).attemptId, 'authored-task-identity');
    await cp(path.dirname(taskFile), workerTask, { recursive: true });
    updateRun(run.id, {
      status: 'failed',
      slotId: 'macwork-ff-replay-checklist',
      steps: run.steps.map((step) =>
        step.name === PS.WRITE_TASK
          ? { ...step, status: 'done', outputs: { taskFile, skipped: true } }
          : new Set<string>([PS.FIND_SLOT, PS.PREPARE, PS.DISPATCH, PS.MONITOR]).has(step.name)
            ? { ...step, status: 'done' }
            : step,
      ),
    });
    await runReplayStep({ runId: run.id, stepName: PS.MONITOR, triggeredBy: 'operator' }, () => {});
    assert.equal(getRun(run.id)?.recordedEvidenceContractVersion, 1);
    assert.equal(await readFile(taskFile, 'utf8'), text);
    assert.equal(
      await readFile(path.join(workerTask, 'inputs/worker-terminal-contract.json'), 'utf8'),
      contract,
    );
    assert.equal(await readFile(path.join(workerTask, 'inputs/handoff.json'), 'utf8'), handoff);
  });
}
