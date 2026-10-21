import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test, type TestContext } from 'node:test';

import type { AgentContext } from '@farmslot/protocol';

import type { RunEngineStepStartAcknowledgement } from '../../run-engine/orchestrator.js';

const home = mkdtempSync(path.join(tmpdir(), 'worker-resume-binding-'));
process.env.FARMSLOT_HOME = home;
process.env.FARMSLOT_RUNS_DIR = path.join(home, 'runs');
after(() => rmSync(home, { recursive: true, force: true }));
await import('../../runtime/mock-pty.test-support.js');

const unexpected = () => {
  throw new Error('Unexpected engine operation in resume fixture');
};
mock.module('../../run-engine/orchestrator.js', {
  namedExports: {
    cleanupSlotAfterRunFailure: unexpected,
    setRunFlags: unexpected,
    terminalSlotCleanup: unexpected,
    initRunEngine: unexpected,
    applyChainedRunEngineFlags: unexpected,
    cleanupEvalHarnessForTerminalRun: unexpected,
    startRun: unexpected,
    stepEntryTiming: unexpected,
    cancelRunEngine: () => {},
    rearmPublicationReviewRecoveryForRun: unexpected,
    suspendPublicationReviewRecoveryForRun: unexpected,
    recoverActiveRuns: unexpected,
    startOrphanReconciler: unexpected,
    cleanupSlotProcesses: unexpected,
    bumpRunGeneration: (runId: string) => {
      const run = getRun(runId);
      assert.ok(run);
      const generation = (run.engineState?.generation ?? 0) + 1;
      updateRun(runId, { engineState: { ...run.engineState, generation } });
      return generation;
    },
    startRunWithStepAcknowledgement: async (
      runId: string,
      generation: number,
    ): Promise<RunEngineStepStartAcknowledgement> => {
      updateRun(runId, { status: 'monitoring' });
      return {
        runId,
        generation,
        stepName: 'monitor',
        status: 'monitoring',
        acknowledgedAt: new Date().toISOString(),
      };
    },
  },
});

const config = await import('../../core/config.js');
const exec = await import('../../core/exec.js');
const tmux = await import('../../core/tmux.js');
const registry = await import('../../runners/registry.js');
const { makeVars } = await import('../../runners/test-fixtures.js');
const vars = makeVars({ session: 'resume-fixture' });
interface ResumeSend {
  target: Parameters<typeof registry.sendRunnerInstructionSafely>[1];
  instruction: string;
  options: Parameters<typeof registry.sendRunnerInstructionSafely>[6];
}
const sends: ResumeSend[] = [];
mock.module('../../core/config.js', {
  namedExports: { ...config, loadSlotVars: async () => vars },
});
mock.module('../../core/exec.js', {
  namedExports: {
    ...exec,
    execOnSlot: async (...args: Parameters<typeof exec.execOnSlot>) => {
      assert.match(args[1], /capture-pane/);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  },
});
mock.module('../../core/tmux.js', {
  namedExports: { ...tmux, resolveTmuxSession: async () => 'resume-fixture:dev' },
});
mock.module('../../runners/registry.js', {
  namedExports: {
    ...registry,
    runnerPaneLooksIdle: () => true,
    sendRunnerInstructionSafely: async (
      ...args: Parameters<typeof registry.sendRunnerInstructionSafely>
    ) => {
      sends.push({ target: args[1], instruction: args[3], options: args[6] });
      return true;
    },
  },
});
const { createRun, deleteRun, getRun, updateRun, updateRunStep } =
  await import('../../runs/store.js');
const { runResumeTransitionLocked } = await import('./lifecycle-control.js');

async function pausedWorker(t: TestContext) {
  sends.length = 0;
  const run = createRun({ flowType: 'dev', project: 'example', ticketOrPr: 'RESUME-BOUND' });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  const sessionId = '00000000-0000-4000-8000-000000000007';
  const sessionPath = path.join(home, sessionId + '.jsonl');
  const context: AgentContext = {
    id: 'dev',
    role: 'dev',
    label: 'Worker',
    status: 'idle',
    runId: run.id,
    slotId: vars.slotId,
    runner: 'claude',
    model: 'opus',
    runnerSessionId: sessionId,
    runnerSessionPath: sessionPath,
  };
  updateRun(run.id, {
    status: 'paused',
    slotId: vars.slotId,
    metrics: {
      ...run.metrics,
      runner: 'claude',
      model: 'opus',
      runnerSessionId: sessionId,
      runnerSessionPath: sessionPath,
    },
    agentContexts: [context],
    engineState: { generation: 5 },
  });
  updateRunStep(run.id, 'monitor', { status: 'running' });
  return { run, context, sessionId, sessionPath };
}

test('run resume continues the bound live worker without opening a session command', async (t) => {
  const { run, sessionId, sessionPath } = await pausedWorker(t);
  const result = await runResumeTransitionLocked({ runId: run.id }, () => {});
  assert.equal(result.status, 'monitoring');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].target, 'resume-fixture:dev');
  assert.ok(sends[0].instruction.trim());
  assert.doesNotMatch(sends[0].instruction, /^\s*\//);
  assert.deepEqual(sends[0].options?.retainedSession, { sessionId, sessionPath });
});

test('run resume refuses an unbound worker before sending input or advancing the engine', async (t) => {
  const { run, context } = await pausedWorker(t);
  updateRun(run.id, {
    metrics: { ...run.metrics, runnerSessionId: null, runnerSessionPath: null },
    agentContexts: [{ ...context, runnerSessionId: null, runnerSessionPath: null }],
  });
  await assert.rejects(
    runResumeTransitionLocked({ runId: run.id }, () => {}),
    /verified worker session binding/,
  );
  assert.equal(sends.length, 0);
  assert.equal(getRun(run.id)?.status, 'paused');
  assert.equal(getRun(run.id)?.engineState?.generation, 5);
});
