import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import * as promiseTimers from 'node:timers/promises';

import { WebSocket } from 'ws';

import { NATIVE_WORKER_READ } from '@farmslot/agent-runtime/native';
import {
  type NativeSessionReadResult,
  PipelineSteps,
  type RunReviewResult,
} from '@farmslot/protocol';

const root = mkdtempSync(path.join(tmpdir(), 'workspace-monitor-reconnect-'));
process.env.FARMSLOT_HOME = root;
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
mkdirSync(path.join(root, 'projects/farm'), { recursive: true });
writeFileSync(
  path.join(root, 'projects/farm/project.json'),
  JSON.stringify({ name: 'farm', monitoring: { total_timeout_min: 0.05 } }),
);

let clock = Date.now();
let afterWait: (() => void) | undefined;
const waits: number[] = [];
mock.method(Date, 'now', () => clock);
// Advance only the transport retry clock. No real timer or runner is started.
mock.module('node:timers/promises', {
  namedExports: {
    ...promiseTimers,
    setTimeout: async (ms: number) => {
      waits.push(ms);
      clock += ms;
      afterWait?.();
    },
  },
});

// Pipeline imports include terminal projections; this test never attaches to tmux.
mock.module('../runtime/pty-stream.js', {
  namedExports: {
    onPtyExit: () => () => {},
    ptyExitHandlerCountForTests: () => 0,
    subscribePty: () => {
      throw new Error('No terminal in monitor fixture');
    },
    unsubscribePty: () => {},
    unsubscribeAllPty: () => {},
    writePty: () => {
      throw new Error('No terminal in monitor fixture');
    },
    resizePty: () => {},
    hasPty: () => false,
    reinitTmuxSession: async () => {
      throw new Error('No terminal in monitor fixture');
    },
  },
});

const { createRun, getRun, getAllRuns, updateRun, persistRunNow } =
  await import('../runs/store.js');
const { registerNode, unregisterByWs } = await import('../fleet/machine-registry.js');
const { handleNodeResponse } = await import('../fleet/node-rpc.js');
const { createGatewayAuthRuntime } = await import('../security/auth.js');
mock.module('../runners/native/manager.js', {
  namedExports: { nativeSessionManager: undefined, validateNativeRunner: () => {} },
});
const { requestNativeNode } = await import('../runners/native/node.js');
const { NativeWorkerOperationUncertainError } = await import('../runners/native/worker-error.js');
const runtime = createGatewayAuthRuntime({
  FARMSLOT_HOME: root,
  FARMSLOT_GATEWAY_AUTH_MODE: 'none',
});
const owner = runtime.writer.createPrincipal({ type: 'service', displayName: 'Review owner' }, []);
const machine = 'review-node';
const node = runtime.writer.createPrincipal(
  { type: 'node', displayName: 'Review node', machine, nativeOwnerPrincipalId: owner.id },
  [],
);
runtime.writer.issueCredential(node.id, 'fixture');

const result: RunReviewResult = {
  recommendation: 'APPROVE',
  reviewMd: 'No findings.',
  lineComments: [],
};
let supportReads = 0;
let completionReads = 0;
let disconnectAtCompletion = false;
const support = await import('./support.js');
mock.module('./support.js', {
  namedExports: {
    ...support,
    ensureReviewWorkspaceSupport: async () => {
      supportReads++;
      // Same owner-bound node RPC as production support verification.
      await requestNativeNode(owner.id, machine, 'exec', {}, 100);
      return undefined;
    },
  },
});
mock.module('./task.js', {
  namedExports: {
    materializeReviewWorkspaceTask: async () => {
      throw new Error('Monitor must not recreate a task');
    },
    readReviewWorkspaceSignal: async () => null,
    readReviewWorkspaceProgress: async () => {
      throw new Error('Progress is isolated in this fixture');
    },
    refreshReviewWorkspaceView: async () => 0,
    readReviewWorkspaceCompletion: async () => {
      completionReads++;
      if (disconnectAtCompletion) {
        disconnectAtCompletion = false;
        unregisterByWs(ws);
      }
      await requestNativeNode(owner.id, machine, 'fs.readFile', {}, 100);
      return { signal: { status: 'complete', outcome: 'success' }, result };
    },
    collectReviewWorkspaceSubtaskMetrics: async () => null,
  },
});
mock.module('./progress.js', {
  namedExports: {
    createReviewWorkspaceProgressPublisher: () => ({ publish: async () => null }),
  },
});
const { executeReviewWorkspaceStep } = await import('./pipeline.js');
const { admitReviewRound, reviewRoundAdmissionId } =
  await import('../review/review-round-budget.js');

let snapshot: NativeSessionReadResult;
const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
const ws = {
  readyState: WebSocket.OPEN,
  send(raw: string) {
    const { id, method, params } = JSON.parse(raw);
    requests.push({ method, params });
    handleNodeResponse(
      id,
      true,
      method === 'native.session' ? snapshot : {},
      undefined,
      undefined,
      ws,
    );
  },
} as WebSocket;
function connect(nativeOwner = owner.id) {
  registerNode(
    machine,
    1,
    ws,
    undefined,
    undefined,
    { ownerPrincipalId: nativeOwner, supportsWorkers: true, supportsEnsure: true },
    { principalId: node.id, valid: () => true },
  );
}

function fixture() {
  const run = createRun(
    {
      project: 'farm',
      flowType: 'review-pr',
      ticketOrPr: 'https://github.com/example/app/pull/1',
      mode: 'autonomous',
      transport: 'native',
      runner: 'codex',
      model: 'gpt-6.1-sol',
      reviewWorkspaceTarget: { machine },
    },
    { nativeOwnerPrincipalId: owner.id },
  );
  const binding = {
    sessionId: 'saved-session',
    leaseId: 'saved-lease',
    commandId: 'saved-command',
    generation: 'saved-generation',
    executionNodeId: machine,
    ownerPrincipalId: owner.id,
    acceptedAt: new Date(clock - 1000).toISOString(),
  };
  updateRun(run.id, {
    status: 'monitoring',
    engineState: { generation: 7 },
    steps: [
      { name: PipelineSteps.MONITOR, status: 'running', startedAt: new Date(clock).toISOString() },
    ],
    reviewWorkspace: {
      workspaceId: 'saved-workspace',
      machine,
      executionNodeId: machine,
      checkoutPath: '/fixture/source',
      taskPath: '/fixture/task',
      artifactPath: '/fixture/task/artifacts',
    },
    agentContexts: [
      {
        id: 'review',
        role: 'review',
        label: 'Review',
        status: 'working',
        runId: run.id,
        slotId: null,
        nativeSession: binding,
      },
    ],
    metrics: { ...run.metrics, runnerSessionId: 'saved-conversation' },
  });
  snapshot = {
    session: {
      id: binding.sessionId,
      generation: binding.generation,
      hostPid: 1,
      runner: 'codex',
      nativeSessionId: 'saved-conversation',
      ownerPrincipalId: owner.id,
      executionNodeId: machine,
      accountContextId: 'fixture-account',
      cwd: '/fixture/source',
      executable: 'codex',
      version: 'fixture',
      mode: 'default',
      accountMode: 'native',
      workerManaged: true,
      workerLeaseId: binding.leaseId,
      state: 'idle',
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
        generation: binding.generation,
        commandId: binding.commandId,
        accepted: true,
        submitted: true,
        state: 'completed',
        outcome: 'completed',
      },
    ],
    events: [],
    pendingRequests: [],
    cursor: 0,
    hasMore: false,
    scope: { leaseId: binding.leaseId, startAfter: 0, endAt: 0, released: false },
  };
  return {
    runId: run.id,
    binding,
    monitor: () => executeReviewWorkspaceStep(run.id, PipelineSteps.MONITOR, 7, () => {}),
  };
}

beforeEach(() => {
  unregisterByWs(ws);
  requests.length = waits.length = 0;
  supportReads = completionReads = 0;
  disconnectAtCompletion = false;
  afterWait = undefined;
});
after(async () => {
  unregisterByWs(ws);
  for (const run of getAllRuns()) await persistRunNow(run, 'fixture teardown');
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});

test('restart before node reconnects observes the completed saved command without relaunch', async () => {
  const f = fixture();
  afterWait = () => connect();
  const observed = await f.monitor();
  assert.equal(supportReads, 2);
  assert.equal(completionReads, 1);
  assert.deepEqual(waits, [1000]);
  assert.equal(observed.outputs?.nativeCommandId, f.binding.commandId);
  assert.deepEqual(getRun(f.runId)?.reviewResult, result);
  assert.deepEqual(getRun(f.runId)?.agentContexts?.[0].nativeSession, f.binding);
  const native = requests.filter((request) => request.method === 'native.session');
  assert.deepEqual(
    native.map((request) => request.params?.method),
    [NATIVE_WORKER_READ],
  );
  assert.deepEqual(native[0].params?.params, {
    sessionId: f.binding.sessionId,
    executionNodeId: machine,
    leaseId: f.binding.leaseId,
  });
});

test('a disconnect between the journal and result read retries only observation', async () => {
  const f = fixture();
  connect();
  disconnectAtCompletion = true;
  afterWait = () => connect();
  assert.equal((await f.monitor()).outputs?.nativeCommandId, f.binding.commandId);
  assert.equal(completionReads, 2);
  assert.equal(requests.filter((request) => request.method === 'native.session').length, 1);
});

test('offline observation expiry retains the binding for reconciliation', async () => {
  const f = fixture();
  await assert.rejects(f.monitor(), (error: unknown) => {
    assert(error instanceof NativeWorkerOperationUncertainError);
    assert.equal(error.operation, 'observation');
    return true;
  });
  assert.deepEqual(waits, [1000, 1000, 1000]);
  assert.deepEqual(getRun(f.runId)?.agentContexts?.[0].nativeSession, f.binding);
  assert.equal(requests.length, 0);
});

test('a reconnected node with a different owner is refused without waiting again', async () => {
  const f = fixture();
  afterWait = () => connect('different-owner');
  await assert.rejects(f.monitor(), /unavailable for this owner/);
  assert.deepEqual(waits, [1000]);
  assert.equal(requests.length, 0);
});

/** The receipt this run's DISPATCH admitted at `generation`. */
const workspaceRound = (runId: string, generation: number) =>
  reviewRoundAdmissionId(`workspace-review-${runId}`, generation + 1, getRun(runId)!.createdAt);

test('a reviewer that stops without a result settles the workspace round no-verdict', async () => {
  const f = fixture();
  connect();
  const round = workspaceRound(f.runId, 7);
  await admitReviewRound(f.runId, round);
  snapshot.commands = [{ ...snapshot.commands[0]!, outcome: 'failed' }];
  await assert.rejects(f.monitor(), /stopped before producing a valid result/);
  assert.equal(getRun(f.runId)?.reviewRoundSettlements?.[round]?.reason, 'review-worker-stopped');
});

test('a replay that supersedes the monitor settles that attempt, not the one it dispatched', async () => {
  const f = fixture();
  updateRun(f.runId, { engineState: { generation: 7, workspaceReviewDispatchGeneration: 7 } });
  await admitReviewRound(f.runId, workspaceRound(f.runId, 7));
  await admitReviewRound(f.runId, workspaceRound(f.runId, 8));
  afterWait = () => {
    connect();
    // The operator's replay owns a new generation and has dispatched its own attempt.
    updateRun(f.runId, { engineState: { generation: 8, workspaceReviewDispatchGeneration: 8 } });
  };
  await assert.rejects(f.monitor(), /no longer owns/);
  const settlements = getRun(f.runId)?.reviewRoundSettlements ?? {};
  assert.match(settlements[workspaceRound(f.runId, 7)]?.reason ?? '', /no longer owns/);
  assert.equal(settlements[workspaceRound(f.runId, 8)], undefined);
});

test('a monitor-only replay settles the attempt it superseded; its verdict counts that round again', async () => {
  const f = fixture();
  updateRun(f.runId, { engineState: { generation: 7, workspaceReviewDispatchGeneration: 7 } });
  const round = workspaceRound(f.runId, 7);
  await admitReviewRound(f.runId, round);
  afterWait = () => {
    connect();
    // The replay re-enters MONITOR at a new generation; nothing dispatches again.
    updateRun(f.runId, { engineState: { generation: 8, workspaceReviewDispatchGeneration: 7 } });
  };
  await assert.rejects(f.monitor(), /no longer owns/);
  assert.match(getRun(f.runId)?.reviewRoundSettlements?.[round]?.reason ?? '', /no longer owns/);

  afterWait = undefined;
  await executeReviewWorkspaceStep(f.runId, PipelineSteps.MONITOR, 8, () => {});
  assert.deepEqual(getRun(f.runId)?.reviewResult, result);
  assert.equal(getRun(f.runId)?.reviewRoundSettlements?.[round], undefined);
  assert.equal(getRun(f.runId)?.reviewRoundAdmissions?.filter((id) => id === round).length, 1);
});

test('a monitor that recorded its review result before failing settles nothing', async () => {
  const f = fixture();
  connect();
  const round = workspaceRound(f.runId, 7);
  await admitReviewRound(f.runId, round);
  await assert.rejects(
    executeReviewWorkspaceStep(f.runId, PipelineSteps.MONITOR, 7, () => {
      throw new Error('broadcast failed');
    }),
    /broadcast failed/,
  );
  assert.deepEqual(getRun(f.runId)?.reviewResult, result);
  // Fixture runs share one PR scope, so only this attempt's receipt is checked.
  assert.equal(getRun(f.runId)?.reviewRoundSettlements?.[round], undefined);
});

for (const change of ['cancel', 'generation', 'lease'] as const) {
  test(`${change} during reconnection prevents stale monitor completion`, async () => {
    const f = fixture();
    afterWait = () => {
      connect();
      if (change === 'cancel') updateRun(f.runId, { status: 'cancelled' });
      else if (change === 'generation') updateRun(f.runId, { engineState: { generation: 8 } });
      else snapshot.session.workerLeaseId = 'different-lease';
    };
    await assert.rejects(f.monitor(), /no longer owns|invalid worker history scope/);
    assert.equal(getRun(f.runId)?.reviewResult, undefined);
    assert.equal(completionReads, 0);
  });
}
