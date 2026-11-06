import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test, type TestContext } from 'node:test';
import * as promiseTimers from 'node:timers/promises';

import {
  type NativeSessionReadResult,
  type NativeWorkerSessionBinding,
  PipelineSteps,
  type Run,
  type RunReviewResult,
  type WorkerSignal,
} from '@farmslot/protocol';

const root = mkdtempSync(path.join(tmpdir(), 'review-output-repair-'));
process.env.FARMSLOT_HOME = root;
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'review-owner';
after(() => rmSync(root, { recursive: true, force: true }));
await import('../runtime/mock-pty.test-support.js');

const { GatewayMethodError } = await import('../core/method-error.js');
let clock = Date.now();
let afterWait: (() => void) | undefined;
let reviewerExists = true;
mock.method(Date, 'now', () => clock);
mock.module('node:timers/promises', {
  namedExports: {
    ...promiseTimers,
    setTimeout: async (ms: number) => {
      clock += ms;
      afterWait?.();
    },
  },
});
let terminalFailure: Error | undefined;
let repairResolves = true;
let nativeRepairCommand: string | undefined;
let nativeRepairReads = 0;
const nativeBinding: NativeWorkerSessionBinding = {
  sessionId: 'original-native-session',
  leaseId: 'lease',
  generation: 'generation',
  commandId: 'original-command',
  ownerPrincipalId: 'review-owner',
  executionNodeId: 'review-node',
  acceptedAt: new Date(clock - 1000).toISOString(),
};
const instructions: Array<{ sessionId?: string | null; text?: string }> = [];
let signal: WorkerSignal | null = null;
let launches = 0;
const result: RunReviewResult = {
  recommendation: 'APPROVE',
  reviewMd: 'Frozen head reviewed.',
  lineComments: [],
};
mock.module('./task.js', {
  namedExports: {
    reviewWorkspaceProgressLocation: async () => ({
      io: { host: 'localhost', machine: 'local', sshTarget: '' },
      taskDir: '/owned/task',
      checklistPath: '/owned/task/CHECKLIST.md',
    }),
    materializeReviewWorkspaceTask: async () => {
      launches++;
      throw new Error('Recovery must not recreate the task or dispatch a reviewer');
    },
    readReviewWorkspaceSignal: async () => signal,
    readReviewWorkspaceCompletion: async () => {
      if (terminalFailure) throw terminalFailure;
      return signal?.status === 'complete' ? { signal, result } : null;
    },
    collectReviewWorkspaceSubtaskMetrics: async () => null,
    readReviewWorkspaceProgress: async () => null,
    refreshReviewWorkspaceView: async () => 0,
  },
});
const startup = await import('../runners/review-startup.js');
mock.module('../runners/review-startup.js', {
  namedExports: {
    ...startup,
    observeReviewPromptAcceptance: async () => null,
  },
});
const terminal = await import('../runners/review-tmux.js');
mock.module('../runners/review-tmux.js', {
  namedExports: {
    ...terminal,
    reviewTmuxOperation: async (_run: Run, action: string) => {
      assert.equal(action, 'inspect');
      return { exists: reviewerExists };
    },
  },
});
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: { ...config, loadProjectVars: async () => ({ projectJson: {} }) },
});
const support = await import('./support.js');
mock.module('./support.js', {
  namedExports: { ...support, ensureReviewWorkspaceSupport: async () => {} },
});
mock.module('./progress.js', {
  namedExports: { createReviewWorkspaceProgressPublisher: () => ({ publish: async () => null }) },
});
const { createRun, getRun, updateRun, updateRunStep, persistRunNow, deleteRun } =
  await import('../runs/store.js');
const { admitReviewRound, reviewRoundAdmissionId, settleReviewRoundNoVerdict } =
  await import('../review/review-round-budget.js');
const workspaceTerminal = await import('../runtime/workspace-terminal.js');
mock.module('../runtime/workspace-terminal.js', {
  namedExports: {
    ...workspaceTerminal,
    workspaceTerminalOperation: async (run: Run, action: string, input: { text?: string }) => {
      assert.equal(action, 'send');
      instructions.push({ sessionId: run.agentContexts?.[0].runnerSessionId, text: input.text });
      if (repairResolves) terminalFailure = undefined;
      signal = {
        status: 'complete',
        outcome: 'success',
        attemptId: 'original-attempt',
        timestamp: new Date(clock + 1).toISOString(),
      };
      clock += 1;
      return [];
    },
  },
});
const nativeControls = await import('../runners/native/worker-control.js');
mock.module('../runners/native/worker-control.js', {
  namedExports: {
    ...nativeControls,
    sendNativeWorkerInstruction: async (
      input: Parameters<typeof nativeControls.sendNativeWorkerInstruction>[0],
    ) => {
      assert.equal(input.slotId, null);
      assert.equal(input.contextId, 'review');
      instructions.push({ sessionId: nativeBinding.sessionId, text: input.text });
      nativeRepairCommand = nativeControls.nativeWorkerInstructionCommandId(
        input.runId,
        nativeBinding,
        input.key,
        input.text,
      );
      if (repairResolves) terminalFailure = undefined;
      signal = {
        status: 'complete',
        outcome: 'success',
        attemptId: 'original-attempt',
        timestamp: new Date(clock + 1).toISOString(),
      };
      clock++;
      return 'confirmed';
    },
  },
});
const nativeWorkspace = await import('../runners/native/review-workspace.js');
mock.module('../runners/native/review-workspace.js', {
  namedExports: {
    ...nativeWorkspace,
    readReviewWorkspaceWorker: async (): Promise<NativeSessionReadResult> => ({
      session: {
        id: nativeBinding.sessionId,
        generation: nativeBinding.generation!,
        workerLeaseId: nativeBinding.leaseId,
        ownerPrincipalId: 'review-owner',
        executionNodeId: 'review-node',
        state: nativeRepairCommand && nativeRepairReads === 0 ? 'running' : 'idle',
        processPid: 123,
        hostPid: 122,
        runner: 'claude',
        nativeSessionId: 'original-session',
        accountContextId: 'fixture',
        cwd: '/owned/source',
        executable: 'claude',
        version: 'fixture',
        mode: 'default',
        accountMode: 'native',
        capabilities: {
          modes: ['default'],
          streaming: true,
          tools: true,
          approvals: true,
          questions: true,
          interrupt: true,
          resume: true,
        },
      },
      events: [],
      pendingRequests: [],
      cursor: 0,
      hasMore: false,
      commands: [
        {
          generation: nativeBinding.generation!,
          commandId: nativeBinding.commandId,
          accepted: true,
          submitted: true,
          state: 'completed',
          outcome: 'completed',
        },
        ...(nativeRepairCommand
          ? [
              {
                generation: nativeBinding.generation!,
                commandId: nativeRepairCommand,
                accepted: true,
                submitted: true,
                state: nativeRepairReads === 0 ? ('accepted' as const) : ('completed' as const),
                outcome: ++nativeRepairReads === 1 ? undefined : ('completed' as const),
              },
            ]
          : []),
      ],
    }),
  },
});
const { executeReviewWorkspaceStep } = await import('./pipeline.js');

beforeEach(() => {
  nativeRepairCommand = undefined;
  nativeRepairReads = 0;
  afterWait = undefined;
  reviewerExists = true;
  terminalFailure = undefined;
  repairResolves = true;
  instructions.length = 0;
  signal = null;
  launches = 0;
});

async function fixture(
  t: TestContext,
  ticketOrPr = 'example/mobile#42',
  transport: 'tmux' | 'native' = 'tmux',
) {
  const created = createRun(
    {
      project: 'farm',
      flowType: 'review-pr',
      ticketOrPr,
      runner: 'claude',
      model: 'opus',
      transport,
      reviewWorkspaceTarget: { machine: 'review-node' },
    },
    { nativeOwnerPrincipalId: 'review-owner' },
  );
  const delivered = '2026-10-22T05:52:45.277Z';
  const run = updateRun(created.id, {
    status: 'reconciling',
    slotId: null,
    error: 'Reviewer has not acknowledged its task.',
    engineState: { generation: 0, workspaceReviewDispatchGeneration: 0 },
    reviewRoundAdmissions: [],
    steps: [
      { name: PipelineSteps.DISPATCH, status: 'done', outputs: { session: 'original-reviewer' } },
      { name: PipelineSteps.MONITOR, status: 'done', detail: 'review-startup-unacknowledged' },
      { name: PipelineSteps.HUMAN_GATE, status: 'skipped' },
      { name: PipelineSteps.COMPLETE, status: 'skipped' },
    ],
    reviewWorkspace: {
      workspaceId: created.id,
      machine: 'review-node',
      executionNodeId: 'review-node',
      checkoutPath: '/owned/source',
      taskPath: '/owned/task',
      artifactPath: '/owned/task/artifacts',
    },
    agentContexts: [
      {
        id: 'review',
        role: 'review',
        label: 'Review',
        status: 'waiting',
        runId: created.id,
        slotId: null,
        runner: 'claude',
        model: 'opus',
        runnerSessionId: 'original-session',
        ...(transport === 'native'
          ? { nativeSession: nativeBinding }
          : { target: { session: 'original-reviewer', target: 'original-reviewer' } }),
        promptDeliveryStartedAt: delivered,
        attemptStartedAt: delivered,
        signalAttemptId: 'original-attempt',
      },
    ],
  });
  const round = reviewRoundAdmissionId(`workspace-review-${run.id}`, 1, run.createdAt);
  await admitReviewRound(run.id, round);
  await settleReviewRoundNoVerdict(run.id, round, 'review-startup-unacknowledged');
  t.after(async () => {
    const current = getRun(run.id)!;
    await persistRunNow(
      updateRun(run.id, {
        status: 'cancelled',
        reviewWorkspace: { ...current.reviewWorkspace!, cleanedAt: new Date().toISOString() },
        agentContexts: current.agentContexts?.map((context) =>
          context.nativeSession
            ? {
                ...context,
                nativeSession: {
                  ...context.nativeSession,
                  closedAt: new Date().toISOString(),
                  releasedAt: new Date().toISOString(),
                },
              }
            : context,
        ),
      }),
    );
    await deleteRun(run.id);
  });
  return { run, round, delivered };
}

const invalidReview = () =>
  new GatewayMethodError(
    'REVIEW_OUTPUT_INVALID',
    'artifacts/review-result.json: an issues verdict requires at least one finding',
  );

test('schema-invalid static review is corrected once in the same reviewer session', async (t) => {
  const { run, delivered } = await fixture(t);
  updateRun(run.id, { status: 'monitoring' });
  signal = {
    status: 'complete',
    outcome: 'success',
    attemptId: 'original-attempt',
    timestamp: new Date(Date.parse(delivered) + 1000).toISOString(),
  };
  terminalFailure = invalidReview();
  await executeReviewWorkspaceStep(run.id, PipelineSteps.MONITOR, 0, () => {});
  assert.equal(instructions.length, 1);
  assert.equal(instructions[0].sessionId, 'original-session');
  assert.match(instructions[0].text ?? '', /issues verdict requires at least one finding/);
  assert.deepEqual(getRun(run.id)?.reviewResult, result);
  assert.equal(launches, 0);
});

test('a fresh invalid result after the one correction fails without another prompt', async (t) => {
  const { run, delivered } = await fixture(t);
  updateRun(run.id, { status: 'monitoring' });
  signal = {
    status: 'complete',
    outcome: 'success',
    attemptId: 'original-attempt',
    timestamp: new Date(Date.parse(delivered) + 1000).toISOString(),
  };
  terminalFailure = invalidReview();
  repairResolves = false;
  await assert.rejects(
    executeReviewWorkspaceStep(run.id, PipelineSteps.MONITOR, 0, () => {}),
    { code: 'REVIEW_OUTPUT_INVALID' },
  );
  assert.equal(instructions.length, 1);
  assert.equal(getRun(run.id)?.reviewResult, undefined);
});

test('an ownership or infrastructure error is not sent to the reviewer as an output correction', async (t) => {
  const { run, delivered } = await fixture(t);
  updateRun(run.id, { status: 'monitoring' });
  signal = {
    status: 'complete',
    outcome: 'success',
    attemptId: 'original-attempt',
    timestamp: new Date(Date.parse(delivered) + 1000).toISOString(),
  };
  terminalFailure = new Error('Static review task identity changed');
  await assert.rejects(
    executeReviewWorkspaceStep(run.id, PipelineSteps.MONITOR, 0, () => {}),
    /identity changed/,
  );
  assert.equal(instructions.length, 0);
});

test('a stopped reviewer is an explicit step failure rather than a reconciling hold', async (t) => {
  const { run, delivered } = await fixture(t);
  updateRun(run.id, { status: 'monitoring' });
  reviewerExists = false;
  signal = {
    status: 'running',
    attemptId: 'original-attempt',
    timestamp: new Date(Date.parse(delivered) + 1000).toISOString(),
  };
  await assert.rejects(
    executeReviewWorkspaceStep(run.id, PipelineSteps.MONITOR, 0, () => {}),
    { code: 'REVIEW_WORKER_STOPPED' },
  );
  assert.equal(instructions.length, 0);
});

test('a restored correction receipt waits for a fresh signal without resending', async (t) => {
  const { run, delivered } = await fixture(t);
  updateRun(run.id, { status: 'monitoring' });
  updateRunStep(run.id, PipelineSteps.MONITOR, {
    outputs: {
      reviewOutputRepair: {
        requestedAt: new Date(clock).toISOString(),
        error: invalidReview().message,
      },
    },
  });
  signal = {
    status: 'complete',
    outcome: 'success',
    attemptId: 'original-attempt',
    timestamp: new Date(Date.parse(delivered) + 1000).toISOString(),
  };
  terminalFailure = invalidReview();
  afterWait = () => {
    terminalFailure = undefined;
    signal = { ...signal!, timestamp: new Date(clock + 1).toISOString() };
    afterWait = undefined;
  };
  await executeReviewWorkspaceStep(run.id, PipelineSteps.MONITOR, 0, () => {});
  assert.equal(instructions.length, 0);
  assert.deepEqual(getRun(run.id)?.reviewResult, result);
});

test('native correction waits for its own command rather than the original completed turn', async (t) => {
  const { run, delivered } = await fixture(t, 'example/mobile#43', 'native');
  updateRun(run.id, { status: 'monitoring' });
  signal = {
    status: 'complete',
    outcome: 'success',
    attemptId: 'original-attempt',
    timestamp: new Date(Date.parse(delivered) + 1000).toISOString(),
  };
  terminalFailure = invalidReview();
  await executeReviewWorkspaceStep(run.id, PipelineSteps.MONITOR, 0, () => {});
  assert.equal(instructions.length, 1);
  assert.equal(instructions[0].sessionId, nativeBinding.sessionId);
  assert(nativeRepairReads >= 2, 'The correction command must finish before capture');
  assert.deepEqual(getRun(run.id)?.reviewResult, result);
  assert.equal(getRun(run.id)?.agentContexts?.[0].runnerSessionId, 'original-session');
});
