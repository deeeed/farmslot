import assert from 'node:assert/strict';
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
    farmslotRoot: path.resolve(import.meta.dirname, '../../../../..'),
    loadSlotVars: async () => ({
      remoteRepo: workspace,
      host: 'localhost',
      machine: os.hostname(),
      slotId: 'macwork-ff-replay-checklist',
      projectName: 'farmslot-farm',
    }),
    loadProjectVars: async () => ({ projectJson: {} }),
    isIgnoredPoolFile: () => false,
    normalizeRawProjectAutoRecovery: () => undefined,
    normalizeRawProjectBacklog: () => undefined,
    normalizeRawProjectPrepare: () => undefined,
    normalizeRawProjectRoadmap: () => undefined,
    getOrchestratorTaskRoot: () => orchestratorTaskRoot,
    resolveSlot: async () => ({
      pool: {},
      slot: { id: 'macwork-ff-replay-checklist' },
    }),
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

mock.module('../../core/tmux.js', {
  namedExports: {
    shellQuote: (value: string) => `'${value.replaceAll("'", "'\\''")}'`,
  },
});

mock.module('../../backlog/dispatch-queue.js', {
  namedExports: {
    claimQueueItemForReplay: () => null,
    getQueueSnapshot: () => [],
    persistQueueNow: async () => {},
    releaseQueueClaim: () => {},
    removeQueueItemInternal: () => {},
    renewQueueClaim: () => false,
  },
});

mock.module('../../family-observability/context.js', {
  namedExports: {
    isFollowUpFlow: () => false,
  },
});

mock.module('../dispatch/ticket-ref.js', {
  namedExports: {
    validateTicketRef: () => {},
  },
});

mock.module('../../run-engine/gate-policy.js', {
  namedExports: {
    hasValidPrNumber: (value: unknown) => Number.isInteger(value) && Number(value) > 0,
    supersedeStaleHumanGateDecisions: () => {},
  },
});

mock.module('../filesystem.js', {
  namedExports: {
    invalidateRecipeRunGroupCache: () => {},
  },
});

mock.module('../../fleet/state.js', {
  namedExports: {
    farmslotRoot: path.resolve(import.meta.dirname, '../../../../..'),
    isValidSafetyTier: () => true,
  },
});

mock.module('../../live-recipe/context.js', {
  namedExports: {
    invalidateLiveRecipeContextMemo: () => {},
  },
});

mock.module('../../runners/registry.js', {
  namedExports: {
    assertSupportedRunnerSpelling: () => {},
    normalizeRunner: (runner: string) => runner,
    runnerDefaultModel: () => 'test-model',
    runnerDefaultSafetyTier: () => 'sandboxed',
  },
});

mock.module('../../tasks/writer.js', {
  namedExports: {
    buildChecklistMarkerScript: () => '#!/bin/bash\n',
    checklistMarkerHelperPath: () => '/tmp/checklist-marker.mjs',
  },
});

mock.module('../../run-engine/orchestrator.js', {
  namedExports: {
    ...realOrchestrator,
    cancelRunEngine: () => {},
    bumpRunGeneration: () => {},
    setRunFlags: () => {},
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
