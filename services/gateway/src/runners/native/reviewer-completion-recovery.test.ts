import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import { NATIVE_WORKER_RESUME, NATIVE_WORKER_SEND } from '@farmslot/agent-runtime/native';
import {
  type NativeWorkerLaunch,
  nativeWorkerLaunchDigest,
} from '@farmslot/agent-runtime/native/worker-launch';
import {
  type AgentContext,
  Methods,
  type NativeSessionReadResult,
  type Principal,
} from '@farmslot/protocol';

await import('../../runtime/mock-pty.test-support.js');
const core = await import('../../core/index.js');
const io = await import('../../core/slot-io.js');
const launchModule = await import('./worker-launch.js');
const owner = await import('../../security/native-worker-owner.js');
const node = await import('./node.js');
const { rewriteStatusFile } = await import('../../core/state.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../../runs/store.js');
const { runWithSessionOriginator } = await import('../../security/work-originator.js');
const { makeVars } = await import('../test-fixtures.js');
const { NodeRpcTimeoutError } = await import('../../fleet/node-rpc.js');
const { NativeWorkerOperationUncertainError } = await import('./worker-error.js');

const vars = makeVars();
const principal: Principal = {
  id: 'owner',
  subject: { type: 'person', displayName: 'Owner' },
  roles: [{ role: 'admin', scope: { kind: 'global' } }],
};
const launch: NativeWorkerLaunch = {
  leaseId: 'lease',
  safetyTier: 'sandboxed',
  environment: { set: {}, unset: [] },
};
let snapshot: NativeSessionReadResult;
let loseReply: 'resume' | 'send' | undefined;
let afterRead: (() => Promise<void>) | undefined;
let preparedLaunch: NativeWorkerLaunch = launch;
const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    loadSlotVars: async () => vars,
    loadProjectVars: async () => ({ projectJson: {} }),
  },
});
mock.module('../../core/slot-io.js', {
  namedExports: { ...io, slotRealpath: async () => vars.remoteRepo },
});
mock.module('./worker-launch.js', {
  namedExports: {
    ...launchModule,
    prepareNativeWorkerLaunch: async () => ({ launch: preparedLaunch }),
  },
});
mock.module('../../security/native-worker-owner.js', {
  namedExports: { ...owner, assertNativeRunOwner: () => {} },
});
mock.module('../../methods/dispatch/execute.js', {
  namedExports: { enforceDispatchPressureGate: async () => {} },
});
mock.module('./node.js', {
  namedExports: {
    ...node,
    routeNativeExecution: async (
      _owner: string,
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push({ method, params });
      if (method === Methods.NATIVE_SESSION_READ) {
        await afterRead?.();
        return structuredClone(snapshot);
      }
      if (method === NATIVE_WORKER_RESUME) {
        assert.equal(params.resumeSessionId, 'saved-conversation');
        snapshot.session = {
          ...snapshot.session,
          generation: 'resumed',
          state: 'idle',
          processStopped: false,
        };
        if (loseReply === 'resume') {
          loseReply = undefined;
          throw new NodeRpcTimeoutError('fixture', 1);
        }
        return { session: snapshot.session };
      }
      assert.equal(method, NATIVE_WORKER_SEND);
      assert.equal(typeof params.commandId, 'string');
      if (!snapshot.commands.some((entry) => entry.commandId === params.commandId))
        snapshot.commands.push({
          generation: snapshot.session.generation,
          commandId: String(params.commandId),
          state: 'accepted',
          submitted: true,
          accepted: true,
        });
      if (loseReply === 'send') {
        loseReply = undefined;
        throw new NodeRpcTimeoutError('fixture', 1);
      }
      return { commandId: params.commandId, accepted: true };
    },
  },
});
const { resumeNativeWorker } = await import('./worker-recovery.js');
const strictControlModule: string = './worker-control.js?operator-recovery-probe';
const strictControls: typeof import('./worker-control.js') = await import(strictControlModule);
mock.module('./worker-control.js', { namedExports: { ...strictControls } });
const instructionModule: string = '../operator-instruction.js?lost-resume-integration';
const { deliverOperatorInstruction }: typeof import('../operator-instruction.js') = await import(
  instructionModule
);

async function fixture(t: TestContext, stopped: boolean) {
  calls.length = 0;
  loseReply = undefined;
  afterRead = undefined;
  preparedLaunch = launch;
  const previous = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = principal.id;
  t.after(() => {
    if (previous === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previous;
  });
  const run = runWithSessionOriginator(principal, () =>
    createRun({
      flowType: 'dev',
      project: 'completion-recovery',
      ticketOrPr: 'COMPLETION',
      transport: 'native',
      slotId: vars.slotId,
    }),
  );
  const context: AgentContext = {
    id: 'reviewer',
    role: 'review',
    label: 'Reviewer',
    status: 'working',
    runId: run.id,
    slotId: vars.slotId,
    runner: 'codex',
    model: 'review-model',
    taskFile: 'tasks/review/REVIEW.md',
    runnerSessionId: 'saved-conversation',
    nativeCommandId: 'one-completion',
    nativeCommandText: 'Finish the existing checklist',
    nativeSession: {
      sessionId: 'session',
      leaseId: 'lease',
      generation: 'original',
      commandId: 'original-command',
      ownerPrincipalId: 'owner',
      executionNodeId: 'local',
      acceptedAt: new Date().toISOString(),
      launchDigest: nativeWorkerLaunchDigest(launch),
      safetyTier: 'sandboxed',
    },
  };
  updateRun(run.id, {
    status: 'reviewing',
    taskFile: 'tasks/review/TASK.md',
    activeTaskFile: context.taskFile ?? undefined,
    agentContexts: [context],
  });
  snapshot = {
    session: {
      id: 'session',
      generation: 'original',
      nativeSessionId: 'saved-conversation',
      runner: 'codex',
      hostPid: 1,
      ownerPrincipalId: 'owner',
      executionNodeId: 'local',
      accountContextId: 'account',
      cwd: vars.remoteRepo,
      executable: 'fixture',
      version: 'fixture',
      mode: 'default',
      accountMode: 'native',
      workerManaged: true,
      workerLeaseId: 'lease',
      state: stopped ? 'closed' : 'idle',
      processStopped: stopped,
      capabilities: {
        modes: ['default'],
        streaming: true,
        tools: true,
        approvals: false,
        questions: false,
        interrupt: true,
        resume: true,
      },
    },
    commands: [
      {
        generation: 'original',
        commandId: 'original-command',
        state: stopped ? 'failed' : 'completed',
        outcome: stopped ? 'failed' : 'completed',
        submitted: true,
        accepted: true,
      },
    ],
    events: [],
    pendingRequests: [],
    cursor: 0,
    hasMore: false,
  };
  await rewriteStatusFile((status) => ({
    ...status,
    slots: [
      ...(status?.slots ?? []).filter((entry) => entry.slot !== vars.slotId),
      { slot: vars.slotId, current_run_id: run.id },
    ],
  }));
  t.after(async () => {
    afterRead = undefined;
    updateRun(run.id, {
      status: 'done',
      agentContexts: getRun(run.id)!.agentContexts?.map((entry) => ({
        ...entry,
        nativeSession: entry.nativeSession
          ? { ...entry.nativeSession, closedAt: new Date().toISOString(), recovery: undefined }
          : undefined,
      })),
    });
    await deleteRun(run.id);
    await rewriteStatusFile((status) => ({
      ...status,
      slots: (status?.slots ?? []).filter((entry) => entry.slot !== vars.slotId),
    }));
  });
  const resume = () =>
    resumeNativeWorker(run.id, {
      purpose: 'review',
      contextId: context.id,
      commandId: context.nativeCommandId,
      text: context.nativeCommandText!,
    });
  return { run, context, resume };
}

test('handoff resumes with its validated launch after pool settings change and reconciles a lost reply', async (t) => {
  const { run, context } = await fixture(t, true);
  await updateRun(run.id, {
    agentContexts: [
      {
        ...context,
        nativeSession: {
          ...context.nativeSession!,
          acceptedAt: undefined,
          handoffFrom: { runId: run.id, contextId: 'previous-review', leaseId: 'previous-lease' },
          handoffCompletedAt: new Date().toISOString(),
        },
      },
    ],
  });
  preparedLaunch = {
    ...launch,
    environment: { set: { PROVIDER_ROOT: '/providers/new' }, unset: [] },
  };
  const resume = () =>
    resumeNativeWorker(run.id, {
      purpose: 'handoff',
      contextId: context.id,
      launch,
      assertCurrent: () => {},
    });
  loseReply = 'resume';
  await assert.rejects(resume(), NodeRpcTimeoutError);
  assert.ok(getRun(run.id)!.agentContexts![0]!.nativeSession!.recovery);
  await resume();
  const current = getRun(run.id)!.agentContexts![0]!;
  assert.equal(current.nativeSession!.generation, 'resumed');
  assert.equal(current.nativeSession!.recovery, undefined);
  assert.equal(current.runnerSessionId, 'saved-conversation');
  assert.equal(calls.filter((call) => call.method === NATIVE_WORKER_RESUME).length, 1);
  assert.equal(calls.filter((call) => call.method === NATIVE_WORKER_SEND).length, 0);
});

for (const stopped of [false, true])
  test(`completion ${stopped ? 'resumes a stopped' : 'continues a live idle'} reviewer once`, async (t) => {
    const { run, resume } = await fixture(t, stopped);
    await resume();
    await resume();
    assert.equal(calls.filter((call) => call.method === NATIVE_WORKER_SEND).length, 1);
    assert.equal(
      calls.filter((call) => call.method === NATIVE_WORKER_RESUME).length,
      stopped ? 1 : 0,
    );
    const context = getRun(run.id)!.agentContexts![0];
    assert.equal(context.runnerSessionId, 'saved-conversation');
    assert.equal(context.nativeSession?.sessionId, 'session');
    assert.equal(context.nativeSession?.commandId, 'one-completion');
    assert.equal(context.nativeSession?.recovery, undefined);
  });

for (const lost of ['resume', 'send'] as const)
  test(`lost ${lost} reply reconciles the same completion command`, async (t) => {
    const { run, resume } = await fixture(t, true);
    loseReply = lost;
    await assert.rejects(resume(), NativeWorkerOperationUncertainError);
    assert.equal(
      getRun(run.id)!.agentContexts![0].nativeSession?.recovery?.commandId,
      'one-completion',
    );
    await resume();
    assert.equal(calls.filter((call) => call.method === NATIVE_WORKER_RESUME).length, 1);
    assert.equal(calls.filter((call) => call.method === NATIVE_WORKER_SEND).length, 1);
    assert.equal(getRun(run.id)!.agentContexts![0].nativeSession?.commandId, 'one-completion');
  });

test('operator feedback reconciles an advanced remote generation after a lost resume reply', async (t) => {
  const { run, context } = await fixture(t, true);
  updateRun(run.id, { status: 'needs-decision' });
  const send = (observeSince?: number) =>
    deliverOperatorInstruction(
      getRun(run.id)!,
      'completion-feedback',
      'Fix the refused video.',
      observeSince,
      context.id,
      'same-feedback-command',
    );
  loseReply = 'resume';
  await assert.rejects(send(), NodeRpcTimeoutError);
  assert.equal(snapshot.session.generation, 'resumed');
  assert.equal(getRun(run.id)!.agentContexts![0].nativeSession!.generation, 'original');
  await assert.rejects(
    strictControls.readNativeWorkerSnapshot(run.id, 'review', context.id),
    /generation/i,
  );
  assert.equal(await send(100), 'confirmed');
  assert.equal(calls.filter((call) => call.method === NATIVE_WORKER_RESUME).length, 1);
  assert.equal(calls.filter((call) => call.method === NATIVE_WORKER_SEND).length, 1);
  const current = getRun(run.id)!.agentContexts![0];
  assert.equal(current.nativeSession!.generation, 'resumed');
  assert.equal(current.nativeSession!.recovery, undefined);
  assert.equal(current.runnerSessionId, 'saved-conversation');
});

test('unsupported saved-session resume and a paused run send no completion input', async (t) => {
  const { run, resume } = await fixture(t, true);
  snapshot.session.capabilities.resume = false;
  await assert.rejects(resume(), /cannot resume this saved conversation/);
  assert.equal(calls.filter((call) => call.method !== Methods.NATIVE_SESSION_READ).length, 0);
  snapshot.session.capabilities.resume = true;
  calls.length = 0;
  updateRun(run.id, { status: 'paused' });
  await assert.rejects(resume(), /paused run/);
  assert.equal(calls.length, 0);
});

test('a changed slot owner prevents completion recovery', async (t) => {
  const { resume } = await fixture(t, true);
  afterRead = async () => {
    await rewriteStatusFile((status) => ({
      ...status,
      slots: [{ slot: vars.slotId, current_run_id: 'successor' }],
    }));
  };
  await assert.rejects(resume(), /ownership changed/);
  assert.equal(calls.filter((call) => call.method !== Methods.NATIVE_SESSION_READ).length, 0);
});
