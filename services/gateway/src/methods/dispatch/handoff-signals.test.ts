import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { Run, WorkerSignal } from '@farmslot/protocol';
import {
  CHECKLIST_TARGET_BY_AGENT_ROLE,
  WORKER_SIGNAL_FILE,
} from '@farmslot/protocol/checklist-target';

import '../../runtime/mock-pty.test-support.js';

import * as slotExec from '../../core/exec.js';
import * as core from '../../core/index.js';
import * as tmux from '../../core/tmux.js';
import * as fleet from '../../fleet/state.js';
import * as lifecycle from '../../review/worker-lifecycle.js';
import { isWorkerSignalFreshForRun } from '../../run-engine/run-monitor.js';
import { makeRun } from '../../run-engine/test-fixtures.js';
import * as acknowledgement from '../../runners/prompt-delivery-evidence.js';
import * as registry from '../../runners/registry.js';
import * as sessions from '../../runners/session-process.js';
import * as delivery from '../../runners/session-reactivation.js';
import * as prompts from '../../runners/worker-prompt.js';
import * as store from '../../runs/store.js';
import * as hostedTask from '../../tasks/hosted-task-init.js';

import * as execute from './execute.js';
import * as preview from './preview.js';
import * as baseline from './worktree-baseline.js';

const root = mkdtempSync(path.join(tmpdir(), 'handoff-signals-'));
after(() => rmSync(root, { recursive: true, force: true }));
const repo = path.join(root, 'repo');
const taskFile = path.join(root, 'tasks', 'pr-complete', 'probe', 'TASK.md');
const workerTask = path.join(repo, '.task', 'pr-complete', 'probe');
mkdirSync(path.dirname(taskFile), { recursive: true });
mkdirSync(workerTask, { recursive: true });
writeFileSync(taskFile, '# Owned task\n');
const signalNames = [
  WORKER_SIGNAL_FILE,
  ...Object.values(CHECKLIST_TARGET_BY_AGENT_ROLE).map((target) => target.signal),
];
const oldSignal: WorkerSignal = {
  status: 'failed',
  attemptId: 'old-attempt',
  contextId: 'primary',
  timestamp: '2026-11-12T00:00:00.000Z',
};
let parent: Run;
let requesting: Run;
let admissionRefused = false;
let inputRefused = false;
let staleSignalConsumed: boolean | undefined;
let beforeInput: registry.RunnerPromptMutation | undefined;
let baselineSawSignal: boolean | undefined;
const stoppedAtDelivery = new Error('fixture stopped at actual delivery boundary');
const refusedAdmission = new Error('fixture admission refused');
const refusedInput = new Error('fixture input refused without mutation');

const execOnSlot: typeof slotExec.execOnSlot = async (_vars, command) => {
  assert(command.startsWith('rm -f '));
  assert(command.includes(root));
  execFileSync('sh', ['-c', command]);
  return { exitCode: 0, stdout: '', stderr: '' };
};
mock.module('../../core/exec.js', { namedExports: { ...slotExec, execOnSlot } });
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    execOnSlot,
    loadSlotVars: async () => ({
      slotId: 'proof-1',
      host: 'localhost',
      machine: 'proof',
      remoteRepo: repo,
      projectName: 'proof',
      slotMode: 'pool',
    }),
    loadProjectVars: async () => ({ projectJson: {} }),
    readSlotField: async (_slot: string, field: string) => {
      const fields: Record<string, string> = {
        runner: 'claude',
        model: 'opus',
        current_flow_type: 'pr-complete',
        current_run_id: parent.id,
      };
      return fields[field] ?? null;
    },
  },
});
mock.module('../../core/tmux.js', {
  namedExports: { ...tmux, resolveTmuxSession: async () => 'proof' },
});
mock.module('../../fleet/state.js', {
  namedExports: {
    ...fleet,
    loadFleetStatus: async () => ({
      slots: [{ slot: 'proof-1', currentRunId: parent.id, branch: 'fix/proof' }],
    }),
  },
});
mock.module('../../runs/store.js', {
  namedExports: {
    ...store,
    getRun: (id: string) =>
      id === parent.id ? parent : id === requesting.id ? requesting : undefined,
    getAllRuns: () => [parent, requesting],
  },
});
mock.module('../../review/worker-lifecycle.js', {
  namedExports: { ...lifecycle, isWorkerAlive: async () => true },
});
mock.module('./preview.js', {
  namedExports: { ...preview, verifyBranchAffinityNudgeStillEligible: async () => null },
});
mock.module('./worktree-baseline.js', {
  namedExports: { ...baseline, recordRetainedPrBaseline: async () => {} },
});
mock.module('./execute.js', {
  namedExports: {
    ...execute,
    isRunnerAliveInAnyPane: async () => true,
    enforceDispatchPressureGate: async () => {
      if (admissionRefused) throw refusedAdmission;
    },
  },
});
mock.module('../../tasks/hosted-task-init.js', {
  namedExports: { ...hostedTask, verifyHostedTaskOnSlot: async () => {} },
});
mock.module('../../runners/worker-prompt.js', {
  namedExports: { ...prompts, resolveWorkerNudgePrompt: async () => 'Read the owned task.' },
});
mock.module('../../runners/session-process.js', {
  namedExports: {
    ...sessions,
    resolveRetainedRunnerPane: async () => ({
      target: 'proof:worker.0',
      window: 'worker',
      pane: '0',
    }),
  },
});
function observeDelivery(): never {
  const file = path.join(workerTask, 'SIGNAL.json');
  staleSignalConsumed =
    existsSync(file) &&
    isWorkerSignalFreshForRun(requesting, JSON.parse(readFileSync(file, 'utf8')));
  throw stoppedAtDelivery;
}
mock.module('../../runners/registry.js', {
  namedExports: {
    ...registry,
    withRunnerPromptMutationBoundary: async <Result>(
      onMutation: registry.RunnerPromptMutation,
      send: () => Promise<Result>,
    ) => {
      beforeInput = onMutation;
      try {
        return await send();
      } finally {
        beforeInput = undefined;
      }
    },
    sendRunnerInstructionSafely: async () => {
      if (inputRefused) throw refusedInput;
      await beforeInput?.();
      return observeDelivery();
    },
  },
});
mock.module('../../runners/prompt-delivery-evidence.js', {
  namedExports: {
    ...acknowledgement,
    readLaunchAckSignalSnapshot: async () => {
      baselineSawSignal = existsSync(path.join(workerTask, 'SIGNAL.json'));
      return { raw: null, status: null, mtimeNs: '0' };
    },
  },
});
mock.module('../../runners/session-reactivation.js', {
  namedExports: { ...delivery, deliverPromptWithRetainedFallback: async () => observeDelivery() },
});
// Real signal I/O against the mocked transport; do not substitute the reset itself.
const targetsPath: string = '../../tasks/checklist-target.js?handoff-signal-boundary';
const targets = await import(targetsPath);
mock.module('../../tasks/checklist-target.js', { namedExports: { ...targets } });
const warmPath: string = './warm-session-handoff.js?signal-boundary';
const nudgePath: string = './nudge.js?signal-boundary';
const { warmSessionHandoffDispatch } = (await import(
  warmPath
)) as typeof import('./warm-session-handoff.js');
const { nudgeDispatch } = (await import(nudgePath)) as typeof import('./nudge.js');

function setup(mode: 'warm' | 'nudge'): void {
  admissionRefused = false;
  inputRefused = false;
  staleSignalConsumed = undefined;
  baselineSawSignal = undefined;
  const context = {
    id: 'primary',
    role: 'primary' as const,
    label: 'Worker',
    status: 'working' as const,
    modelQuestions: 'on' as const,
    runner: 'claude',
    model: 'opus',
    signalAttemptId: 'old-attempt',
    attemptStartedAt: '2026-11-12T00:00:00.000Z',
    runnerSessionId: '11111111-1111-4111-8111-111111111111',
    runnerSessionPath: '/sessions/fixture.jsonl',
    target: { session: 'proof', window: 'worker', pane: '0', target: 'proof:worker.0' },
  };
  const metrics: Run['metrics'] = {
    nudgeCount: 0,
    runner: 'claude',
    model: 'opus',
    runnerSessionId: context.runnerSessionId,
    runnerSessionPath: context.runnerSessionPath,
  };
  parent = {
    ...makeRun({
      id: 'parent',
      project: 'proof',
      slotId: 'proof-1',
      flowType: 'pr-complete',
      mode: 'interactive',
      status: 'monitoring',
      ticketOrPr: 'example/repo#1',
      metrics,
    }),
    transport: 'tmux',
    agentContexts: [{ ...context, runId: 'parent', slotId: 'proof-1' }],
  };
  requesting = {
    ...makeRun({
      id: 'requesting',
      project: 'proof',
      slotId: 'proof-1',
      flowType: 'pr-complete',
      mode: 'interactive',
      transport: 'tmux',
      status: 'dispatching',
      branch: 'fix/proof',
      ticketOrPr: 'example/repo#1',
      taskFile,
      metrics,
      engineState: {
        generation: 2,
        flags: mode === 'warm' ? { warmSessionReuse: true } : { nudgeReuse: true },
      },
      steps: [{ name: 'dispatch', status: 'running', startedAt: '2026-11-12T00:10:00.000Z' }],
    }),
    transport: 'tmux',
    recoveryAttempts: [
      {
        id: 'dispatch-replay',
        attempt: 1,
        stepName: 'dispatch',
        status: 'started',
        startedAt: '2026-11-12T00:10:00.000Z',
        triggeredBy: 'operator',
      },
    ],
    agentContexts: [{ ...context, runId: 'requesting', slotId: 'proof-1' }],
  };
  for (const name of signalNames)
    writeFileSync(path.join(workerTask, name), JSON.stringify(oldSignal));
  assert(
    isWorkerSignalFreshForRun(requesting, oldSignal),
    'bound stale attempt demonstrates the regression',
  );
}
const params = () => ({
  slotId: 'proof-1',
  taskFile,
  runId: requesting.id,
  parentRunId: parent.id,
  runner: 'claude',
  model: 'opus',
  ticketOrPr: 'example/repo#1',
  flowType: 'pr-complete' as const,
});

for (const mode of ['warm', 'nudge'] as const) {
  test(`${mode} delivery cannot expose a previous terminal attempt to the monitor`, async () => {
    setup(mode);
    await assert.rejects(
      mode === 'warm'
        ? warmSessionHandoffDispatch(params(), () => {})
        : nudgeDispatch(params(), () => {}),
      (error) => error === stoppedAtDelivery,
    );
    assert.equal(staleSignalConsumed, false);
    assert(signalNames.every((name) => !existsSync(path.join(workerTask, name))));
    if (mode === 'warm') assert.equal(baselineSawSignal, false, 'baseline follows signal reset');
  });
  test(`${mode} admission refusal preserves every previous signal`, async () => {
    setup(mode);
    admissionRefused = true;
    await assert.rejects(
      mode === 'warm'
        ? warmSessionHandoffDispatch(params(), () => {})
        : nudgeDispatch(params(), () => {}),
      (error) => error === refusedAdmission,
    );
    for (const name of signalNames)
      assert.equal(readFileSync(path.join(workerTask, name), 'utf8'), JSON.stringify(oldSignal));
    assert.equal(staleSignalConsumed, undefined);
  });
}
test('nudge input refusal before mutation preserves the previous signals', async () => {
  setup('nudge');
  inputRefused = true;
  await assert.rejects(
    nudgeDispatch(params(), () => {}),
    (error) => error === refusedInput,
  );
  for (const name of signalNames)
    assert.equal(readFileSync(path.join(workerTask, name), 'utf8'), JSON.stringify(oldSignal));
});
