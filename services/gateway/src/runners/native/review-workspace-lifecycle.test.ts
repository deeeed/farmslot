import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  NATIVE_WORKER_CANCEL,
  NATIVE_WORKER_ENSURE,
  NATIVE_WORKER_READ,
  NATIVE_WORKER_SEND,
  NATIVE_WORKER_STATE,
} from '@farmslot/agent-runtime/native';
import type {
  AgentContext,
  NativeSessionInfo,
  NativeSessionSendResult,
  NativeWorkerSessionBinding,
  Run,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../../core/method-error.js';

import { NativeWorkerOperationUncertainError } from './worker-error.js';

type Call = { method: string; params: Record<string, unknown> };
let run: Run;
let calls: Call[] = [];
let beforeMutation: (() => void | Promise<void>) | undefined;
let afterPersistence: (() => void | Promise<void>) | undefined;
let profileFault: (() => void) | undefined;
let transportFault: ((call: Call) => void) | undefined;
let host: NativeSessionInfo | undefined;
let commands = new Map<string, NativeSessionSendResult>();
let creations = 0;
let turns = 0;
let metricWrites = 0;
let profileReads = 0;

// Keep the actual transport error/classifier; its core dependency is not part of these lifecycle tests.
mock.module('../../core/index.js', {
  namedExports: {
    isLocal: () => true,
    readSlotField: async () => {
      throw new Error('No slot exists in workspace tests');
    },
    loadSlotVars: async () => {
      throw new Error('No slot exists in workspace tests');
    },
  },
});
mock.module('../../agents/contexts.js', {
  namedExports: {
    upsertAgentContext: async (
      _runId: string,
      role: AgentContext['role'],
      patch: Partial<AgentContext>,
      options: {
        guard?: () => Promise<boolean>;
        resolvePatch?: (existing: AgentContext | undefined) => Partial<AgentContext> | null;
      },
    ) => {
      const hook = beforeMutation;
      beforeMutation = undefined;
      await hook?.();
      if (options.guard && !(await options.guard())) return null;
      const existing = run.agentContexts?.find((context) => context.id === patch.id);
      // Invoke the real adapter's queued compare-and-set callback after the injected boundary.
      const resolved = options.resolvePatch ? options.resolvePatch(existing) : patch;
      if (!resolved) return null;
      const context: AgentContext = {
        label: 'Review',
        status: 'working',
        ...existing,
        ...resolved,
        id: patch.id!,
        runId: run.id,
        role,
        slotId: null,
      };
      run.agentContexts = [
        ...(run.agentContexts ?? []).filter((item) => item.id !== context.id),
        context,
      ];
      return context;
    },
    selectAgentContext: (value: Run, selection: { contextId?: string }) =>
      value.agentContexts?.find((context) => context.id === (selection.contextId ?? 'review')),
  },
});
mock.module('../../runs/store.js', {
  namedExports: {
    getRun: () => run,
    updateRun: (_id: string, patch: Partial<Run>) => {
      if (patch.metrics) metricWrites++;
      return Object.assign(run, patch);
    },
    persistRunNow: async () => {
      const hook = afterPersistence;
      afterPersistence = undefined;
      await hook?.();
    },
  },
});
mock.module('../../security/native-worker-owner.js', {
  namedExports: {
    assertNativeRunOwner: (value: Run) => {
      assert.equal(value.nativeOwnerPrincipalId, 'owner');
    },
  },
});
mock.module('../launch-command.js', {
  namedExports: {
    resolveRunnerEffort: () => undefined,
    taskRecipeTrustEnvironment: () => ({ set: {}, unset: [] }),
  },
});
mock.module('../registry.js', { namedExports: { runnerSupportsEffort: () => true } });
mock.module('./manager.js', { namedExports: { validateNativeRunner: () => {} } });
mock.module('./worker-profile.js', {
  namedExports: {
    inspectNativeWorkerProfile: async () => {
      profileReads++;
      profileFault?.();
    },
    nativeWorkerProfileMatches: (info: NativeSessionInfo, binding: NativeWorkerSessionBinding) =>
      info.profileId === binding.profile?.profileId &&
      (!binding.profile || info.accountContextId === binding.profile.accountContextId),
  },
});
mock.module('./node.js', {
  namedExports: {
    routeNativeExecution: async (
      owner: string,
      method: string,
      params: Record<string, unknown>,
    ) => {
      assert.equal(owner, 'owner');
      const call = { method, params: structuredClone(params) };
      calls.push(call);
      let result: unknown;
      if (method === NATIVE_WORKER_STATE) result = { stateDirectory: '/native-state/session' };
      else if (method === NATIVE_WORKER_ENSURE) {
        if (!host) {
          creations++;
          host = {
            id: String(params.sessionId),
            generation: 'generation',
            hostPid: 1,
            processPid: 2,
            ownerPrincipalId: owner,
            executionNodeId: 'local',
            workerLeaseId: String(params.leaseId),
            workerManaged: true,
            nativeSessionId: 'saved-conversation',
            runner: 'codex',
            cwd: '/source',
            executable: 'codex',
            version: '0.154.0',
            mode: 'default',
            accountMode: 'native',
            accountContextId: String(params.accountContextId ?? 'account'),
            ...(params.profileId ? { profileId: String(params.profileId) } : {}),
            capabilities: {
              modes: ['default'],
              streaming: true,
              tools: true,
              approvals: false,
              questions: false,
              interrupt: true,
              resume: true,
            },
            state: 'idle',
          };
        }
        assert.equal(host.id, params.sessionId);
        assert.equal(host.workerLeaseId, params.leaseId);
        result = { session: structuredClone(host) };
      } else if (method === NATIVE_WORKER_READ) {
        assert(host);
        result = {
          session: structuredClone(host),
          commands: [...commands.values()],
          events: [],
          cursor: 0,
          hasMore: false,
          pendingRequests: [],
        };
      } else if (method === NATIVE_WORKER_SEND) {
        const commandId = String(params.commandId);
        if (!commands.has(commandId)) {
          turns++;
          commands.set(commandId, {
            commandId,
            accepted: true,
            submitted: true,
            state: 'accepted',
          });
        }
        result = commands.get(commandId);
      } else if (method === NATIVE_WORKER_CANCEL) {
        if (host) Object.assign(host, { state: 'closed', processStopped: true });
        result = {
          cancelled: true,
          sessionId: params.sessionId,
          leaseId: params.leaseId,
          ...(host ? { generation: host.generation, session: structuredClone(host) } : {}),
        };
      } else throw new Error(`Unexpected operation ${method}`);
      // Fault after the host action to model a lost successful reply, not a rejected command.
      transportFault?.(call);
      return result;
    },
  },
});

const { NodeTransportUnavailableError } = await import('../../fleet/node-rpc.js');
const { launchReviewWorkspaceWorker, readReviewWorkspaceWorker, cancelReviewWorkspaceWorker } =
  await import('./review-workspace.js');

function reset() {
  calls = [];
  commands = new Map();
  host = undefined;
  creations = 0;
  turns = 0;
  metricWrites = 0;
  profileReads = 0;
  beforeMutation = undefined;
  afterPersistence = undefined;
  profileFault = undefined;
  transportFault = undefined;
  run = {
    id: 'lifecycle-fixture',
    slotId: null,
    flowType: 'review-pr',
    transport: 'native',
    status: 'dispatching',
    nativeOwnerPrincipalId: 'owner',
    engineState: { generation: 0 },
    metrics: {
      runner: 'codex',
      model: 'gpt-6-astra',
      runnerSessionId: null,
      runnerSessionPath: null,
      nudgeCount: 0,
    },
    reviewWorkspaceTarget: { machine: 'host' },
    reviewWorkspace: {
      workspaceId: 'workspace',
      machine: 'host',
      executionNodeId: 'local',
      checkoutPath: '/source',
      taskPath: '/task',
      artifactPath: '/task/artifacts',
    },
  } as Run;
}
function launch(deadline = Date.now() + 10_000) {
  return launchReviewWorkspaceWorker({
    runId: run.id,
    project: {},
    prompt: 'Frozen review task',
    deadline,
    assertCurrent: () => {},
  });
}
function faultOnce(method: string) {
  let failed = false;
  transportFault = (call) => {
    if (call.method === method && !failed) {
      failed = true;
      throw new NodeTransportUnavailableError('host', 'timeout', 'lost reply');
    }
  };
}

for (const interruption of ['cancel', 'generation', 'cleaned'] as const) {
  test(`queued reservation rejects ${interruption} before creating a held binding`, async () => {
    reset();
    beforeMutation = () => {
      if (interruption === 'cancel') run.status = 'cancelled';
      if (interruption === 'generation')
        run.engineState!.generation = (run.engineState?.generation ?? 0) + 1;
      if (interruption === 'cleaned') run.reviewWorkspace!.cleanedAt = '2026-09-15T00:00:00Z';
    };
    await assert.rejects(launch(), /no longer admitted/);
    assert.equal(run.agentContexts?.length ?? 0, 0);
    assert.equal(calls.length, 0);
  });
}

test('cancellation after reservation persistence closes that lease and sends no later launch/input', async () => {
  reset();
  afterPersistence = async () => {
    run.status = 'cancelled';
    await cancelReviewWorkspaceWorker(run.id);
    run.reviewWorkspace!.cleanedAt = '2026-09-15T00:00:00Z';
  };
  await assert.rejects(launch(), /no longer admitted/);
  assert(run.agentContexts![0].nativeSession!.closedAt);
  assert.deepEqual(
    calls.map((call) => call.method),
    [NATIVE_WORKER_CANCEL],
  );
});

test('acceptedAt checkpoint recovery repairs native metrics exactly once', async () => {
  reset();
  await launch();
  const acceptedAt = run.agentContexts![0].nativeSession!.acceptedAt;
  run.metrics.runnerSessionId = null;
  metricWrites = 0;
  await readReviewWorkspaceWorker(run.id);
  await readReviewWorkspaceWorker(run.id);
  assert.equal(run.metrics.runnerSessionId, 'saved-conversation');
  assert.equal(metricWrites, 1);
  assert.equal(run.agentContexts![0].nativeSession!.acceptedAt, acceptedAt);
});

for (const method of [NATIVE_WORKER_READ, NATIVE_WORKER_ENSURE, NATIVE_WORKER_SEND]) {
  test(`lost ${method} reply retries the same durable identities`, async () => {
    reset();
    faultOnce(method);
    const result = await launch();
    const attempts = calls.filter((call) => call.method === method);
    assert(attempts.length >= 2);
    assert.deepEqual(attempts[0].params, attempts[1].params);
    assert.equal(creations, 1);
    assert.equal(turns, 1);
    assert.equal(result.session.id, run.agentContexts![0].nativeSession!.sessionId);
    assert(run.agentContexts![0].nativeSession!.acceptedAt);
  });
}

for (const [method, operation] of [
  [NATIVE_WORKER_ENSURE, 'launch'],
  [NATIVE_WORKER_SEND, 'delivery'],
] as const) {
  test(`${operation} deadline uncertainty preserves its host effect and lease`, async () => {
    reset();
    faultOnce(method);
    await assert.rejects(launch(Date.now() - 1), (error: unknown) => {
      assert(error instanceof NativeWorkerOperationUncertainError);
      assert.equal(error.operation, operation);
      return true;
    });
    const binding = structuredClone(run.agentContexts![0].nativeSession!);
    assert.equal(binding.closedAt, undefined);
    assert.equal(binding.releasedAt, undefined);
    assert.equal(
      calls.some((call) => call.method === NATIVE_WORKER_CANCEL),
      false,
    );
    transportFault = undefined;
    await launch();
    const recovered = run.agentContexts![0].nativeSession!;
    assert.equal(recovered.sessionId, binding.sessionId);
    assert.equal(recovered.leaseId, binding.leaseId);
    assert.equal(recovered.commandId, binding.commandId);
    assert.equal(creations, 1);
    assert.equal(turns, 1);
  });
}

test('observation deadline retains the established binding without cancellation', async () => {
  reset();
  await launch();
  const binding = structuredClone(run.agentContexts![0].nativeSession!);
  faultOnce(NATIVE_WORKER_READ);
  await assert.rejects(
    readReviewWorkspaceWorker(run.id, { deadline: Date.now() - 1 }),
    (error: unknown) => {
      assert(error instanceof NativeWorkerOperationUncertainError);
      assert.equal(error.operation, 'observation');
      return true;
    },
  );
  assert.deepEqual(run.agentContexts![0].nativeSession, binding);
  assert.equal(
    calls.some((call) => call.method === NATIVE_WORKER_CANCEL),
    false,
  );
});

test('authority failures and changed generations do not enter the transport retry loop', async () => {
  for (const authority of [true, false]) {
    reset();
    transportFault = (call) => {
      if (call.method !== NATIVE_WORKER_ENSURE) return;
      if (authority) throw new GatewayMethodError('AUTH_FORBIDDEN', 'owner revoked');
      run.engineState!.generation = (run.engineState?.generation ?? 0) + 1;
      throw new NodeTransportUnavailableError('host', 'disconnected', 'lost reply');
    };
    await assert.rejects(launch(), authority ? /owner revoked/ : /no longer admitted/);
    assert.equal(calls.filter((call) => call.method === NATIVE_WORKER_ENSURE).length, 1);
  }
});

test('a transient native-profile observation retries before reserving the worker', async () => {
  reset();
  run.nativeProfile = {
    runner: 'codex',
    executionNodeId: 'local',
    profileId: 'profile',
    accountContextId: 'account',
  };
  profileFault = () => {
    if (profileReads === 1)
      throw new NodeTransportUnavailableError('host', 'disconnected', 'profile connection lost');
  };
  await launch();
  assert.equal(profileReads, 2);
  assert.equal(creations, 1);
  assert.equal(turns, 1);
});

test('native-profile authority failure is terminal before any reservation', async () => {
  reset();
  run.nativeProfile = {
    runner: 'codex',
    executionNodeId: 'local',
    profileId: 'profile',
    accountContextId: 'account',
  };
  profileFault = () => {
    throw new GatewayMethodError('AUTH_FORBIDDEN', 'profile owner revoked');
  };
  await assert.rejects(launch(), /profile owner revoked/);
  assert.equal(profileReads, 1);
  assert.equal(run.agentContexts?.length ?? 0, 0);
  assert.equal(calls.length, 0);
});
