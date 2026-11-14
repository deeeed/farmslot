import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import * as promiseTimers from 'node:timers/promises';

import {
  NATIVE_WORKER_CANCEL,
  NATIVE_WORKER_ENSURE,
  NATIVE_WORKER_READ,
  NATIVE_WORKER_RESUME,
  NATIVE_WORKER_SEND,
  NATIVE_WORKER_STATE,
} from '@farmslot/agent-runtime/native';
import {
  type AgentContext,
  Methods,
  type NativeSessionInfo,
  type NativeSessionSendResult,
  type NativeWorkerSessionBinding,
  type Run,
  runEngineLabel,
  runWorkerEffort,
} from '@farmslot/protocol';
import type { RawPoolJson } from '@farmslot/slot-config';

import { GatewayMethodError } from '../../core/method-error.js';

import { NativeWorkerOperationUncertainError } from './worker-error.js';

await import('../../runtime/mock-pty.test-support.js');
const config = await import('../../core/config.js');
// Loaded before the core mocks below; workspace review uses the real derivation.
const launchCommands = await import('../launch-command.js');
const { modelQuestionsForRun } = launchCommands;
let advanceDelay: ((ms: number) => void) | undefined;
mock.module('node:timers/promises', {
  namedExports: {
    ...promiseTimers,
    setTimeout: (...args: Parameters<typeof promiseTimers.setTimeout>) => {
      if (!advanceDelay) return promiseTimers.setTimeout(...args);
      advanceDelay(args[0] ?? 1);
      return Promise.resolve();
    },
  },
});
const configuredPool = {
  machine: 'host',
  os: 'macos',
  host: 'localhost',
  project: 'demo',
  platform: 'test',
  ssh_user: 'fixture',
  slots: [],
  codex_path: '/configured/outside-path/codex',
} satisfies RawPoolJson;
mock.module('../../core/config.js', {
  namedExports: { ...config, loadMachinePool: async () => configuredPool },
});
let selectedExecutable: string | undefined = 'codex';
let executableSelections: Array<{ runner: string; machine?: RawPoolJson }> = [];

type Call = { method: string; params: Record<string, unknown> };
let run: Run;
let calls: Call[] = [];
let beforeMutation: (() => void | Promise<void>) | undefined;
let afterPersistence: (() => void | Promise<void>) | undefined;
let profileFault: (() => void) | undefined;
let transportFault: ((call: Call) => void) | undefined;
let host: NativeSessionInfo | undefined;
let createdSessionPatch: Partial<NativeSessionInfo> | undefined;
let commands = new Map<string, NativeSessionSendResult>();
let creations = 0;
let turns = 0;
let metricWrites = 0;
let profileReads = 0;

// Keep the actual transport error/classifier; its core dependency is not part of these lifecycle tests.
const core = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    isLocal: () => true,
    readSlotField: async () => {
      throw new Error('No slot exists in workspace tests');
    },
    loadSlotVars: async () => {
      throw new Error('No slot exists in workspace tests');
    },
  },
});
const contexts = await import('../../agents/contexts.js');
mock.module('../../agents/contexts.js', {
  namedExports: {
    ...contexts,
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
const store = await import('../../runs/store.js');
mock.module('../../runs/store.js', {
  namedExports: {
    ...store,
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
const ownership = await import('../../security/native-worker-owner.js');
mock.module('../../security/native-worker-owner.js', {
  namedExports: {
    ...ownership,
    assertNativeRunOwner: (value: Run) => {
      assert.equal(value.nativeOwnerPrincipalId, 'owner');
    },
  },
});
mock.module('../launch-command.js', {
  namedExports: {
    ...launchCommands,
    modelQuestionsForRun,
    machineRunnerPath: (runner: string, machine?: RawPoolJson) => {
      executableSelections.push({ runner, machine });
      return selectedExecutable;
    },
    resolveRunnerEffort: () => undefined,
    taskRecipeTrustEnvironment: () => ({ set: {}, unset: [] }),
  },
});
const registry = await import('../registry.js');
mock.module('../registry.js', { namedExports: { ...registry, runnerSupportsEffort: () => true } });
const manager = await import('./manager.js');
mock.module('./manager.js', { namedExports: { ...manager, validateNativeRunner: () => {} } });
const profile = await import('./worker-profile.js');
mock.module('./worker-profile.js', {
  namedExports: {
    ...profile,
    inspectNativeWorkerProfile: async () => {
      profileReads++;
      profileFault?.();
    },
    nativeWorkerProfileMatches: (info: NativeSessionInfo, binding: NativeWorkerSessionBinding) =>
      info.profileId === binding.profile?.profileId &&
      (!binding.profile || info.accountContextId === binding.profile.accountContextId),
  },
});
const nativeNode = await import('./node.js');
mock.module('./node.js', {
  namedExports: {
    ...nativeNode,
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
            runner: String(params.runner),
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
        if (createdSessionPatch) Object.assign(host, createdSessionPatch);
        result = { session: structuredClone(host) };
      } else if (method === NATIVE_WORKER_RESUME) {
        assert(host);
        assert.equal(params.resumeSessionId, host.nativeSessionId);
        assert.equal(params.leaseId, host.workerLeaseId);
        if (host.generation === params.generation) {
          assert.equal(host.processStopped, true);
          host = {
            ...host,
            generation: 'resumed-generation',
            state: 'idle',
            processStopped: false,
          };
        } else assert.equal(host.generation, 'resumed-generation');
        result = { session: structuredClone(host) };
      } else if (method === NATIVE_WORKER_READ || method === Methods.NATIVE_SESSION_READ) {
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
        const generationChanged = host && params.generation !== host.generation;
        if (host && !generationChanged)
          Object.assign(host, { state: 'closed', processStopped: true });
        result = {
          cancelled: !generationChanged,
          ...(generationChanged ? { reason: 'generation-changed' } : {}),
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
// Install transport mocks before loading the shared worker and review adapters.
await import('./worker.js');
const { launchReviewWorkspaceWorker, readReviewWorkspaceWorker, cancelReviewWorkspaceWorker } =
  await import('./review-workspace.js');

function reset() {
  selectedExecutable = 'codex';
  executableSelections = [];
  calls = [];
  commands = new Map();
  host = undefined;
  createdSessionPatch = undefined;
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
  assert.equal(calls.length, 0, 'No host launch was admitted before cancellation');
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

test('slotless native review captures its request receipt without a terminal target', async (t) => {
  reset();
  await launch();
  const directory = mkdtempSync(path.join(tmpdir(), 'review-receipt-pool-'));
  writeFileSync(path.join(directory, 'host.json'), JSON.stringify(configuredPool));
  const previousPool = process.env.FARMSLOT_POOL_DIR;
  process.env.FARMSLOT_POOL_DIR = directory;
  t.after(() => {
    if (previousPool === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = previousPool;
    rmSync(directory, { recursive: true, force: true });
  });
  run.project = 'demo';
  run.metrics.runner = 'pi';
  run.metrics.model = 'litellm/synthetic-model';
  run.effort = 'off';
  run.createdAt = new Date().toISOString();
  // Readback may run on a gateway whose local OS cannot launch a Pi source sandbox.
  // Seed the retained host fixture; the live recipe covers actual Pi admission.
  assert.ok(host);
  host = {
    ...host,
    runner: 'pi',
    model: run.metrics.model,
    version: '1.4.0',
    nativeSessionPath: '/private/pi/session.jsonl',
  };
  run.agentContexts = run.agentContexts?.map((context) => ({
    ...context,
    runner: 'pi',
    model: run.metrics.model,
    effort: 'off',
  }));
  const observer = registry.getRunnerObservability('pi');
  assert.ok(observer);
  const original = observer.getReasoningReceipt;
  t.after(() => {
    observer.getReasoningReceipt = original;
  });
  let reads = 0;
  observer.getReasoningReceipt = async (vars, session) => {
    reads++;
    assert.equal(vars.session, '');
    assert.equal(vars.remoteRepo, '/source');
    assert.equal(session.sessionId, 'saved-conversation');
    assert.equal(session.sessionPath, '/private/pi/session.jsonl');
    return {
      sessionId: session.sessionId,
      provider: 'litellm',
      model: 'synthetic-model',
      selectedModel: session.model,
      observedAt: new Date().toISOString(),
      reasoning: { mode: 'omitted' },
    };
  };
  await readReviewWorkspaceWorker(run.id);
  await readReviewWorkspaceWorker(run.id);
  assert.equal(run.slotId, null);
  assert.ok(!run.agentContexts?.[0].target);
  assert.equal(run.agentContexts?.[0].reasoningReceipt?.reasoning.mode, 'omitted');
  assert.equal(reads, 1, 'the exact attempt caches its launch receipt');
  assert.equal(
    runEngineLabel({ runner: 'pi', model: run.metrics.model, effort: runWorkerEffort(run) }),
    'pi/litellm/synthetic-model · default',
  );
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

test('native launch binds recorded reference paths and keeps them read-only', async () => {
  reset();
  run.reviewWorkspace!.support = {
    path: '/support',
    sha256: 'a'.repeat(64),
    sources: [],
    skills: [],
    environment: {
      REF_MOBILE: '{{mobile_repo}}',
      REF_CORE: '{{core_repo}}',
      LIBRARY: '{{support}}/libraries/perps',
    },
    references: [
      { name: 'mobile', path: '/dev/mobile-ref', headSha: 'b'.repeat(40), dirty: false },
      { name: 'core', path: '/dev/core-ref', missing: true },
    ],
  };
  await launch();
  const ensure = calls.find((call) => call.method === NATIVE_WORKER_ENSURE)!;
  const launched = ensure.params.launch as {
    environment: { set: Record<string, string> };
    filesystemPolicy: { readOnlyRoots: string[] };
  };
  assert.equal(launched.environment.set.REF_MOBILE, '/dev/mobile-ref');
  assert.equal(launched.environment.set.REF_CORE, '');
  assert.equal(launched.environment.set.LIBRARY, '/support/libraries/perps');
  assert.deepEqual(launched.filesystemPolicy.readOnlyRoots, [
    '/source',
    '/support',
    '/dev/mobile-ref',
  ]);
});

test('native review pins the configured machine executable instead of PATH-selected project shims', async () => {
  reset();
  selectedExecutable = configuredPool.codex_path;
  await launch();
  const ensure = calls.find((call) => call.method === NATIVE_WORKER_ENSURE);
  assert.ok(ensure);
  const launchInput = ensure.params.launch;
  assert.ok(launchInput && typeof launchInput === 'object');
  assert.equal(Reflect.get(launchInput, 'executable'), configuredPool.codex_path);
  assert.equal(executableSelections.length, 1);
  assert.equal(executableSelections[0]?.runner, 'codex');
  assert.equal(executableSelections[0]?.machine, configuredPool);
});

for (const mode of ['autonomous', 'interactive'] as const) {
  test(`a native ${mode} workspace review launches with the model's question tool ${mode === 'autonomous' ? 'off' : 'on'}`, async () => {
    reset();
    run.mode = mode;
    await launch();
    const ensure = calls.find((call) => call.method === NATIVE_WORKER_ENSURE);
    assert.ok(ensure?.params.launch && typeof ensure.params.launch === 'object');
    assert.equal(
      Reflect.get(ensure.params.launch, 'modelQuestions'),
      mode === 'autonomous' ? 'off' : undefined,
    );
  });
}

test('native review without a configured machine path starts the adapter executable, as a chat session does', async () => {
  reset();
  selectedExecutable = undefined;
  await launch();
  const ensure = calls.find((call) => call.method === NATIVE_WORKER_ENSURE);
  assert.ok(ensure);
  const launchInput = ensure.params.launch;
  assert.ok(launchInput && typeof launchInput === 'object');
  assert.equal(Object.hasOwn(launchInput, 'executable'), false);
});

for (const state of ['failed', 'closed'] as const) {
  test(`native review reports ${state} startup cause without claiming a workspace mismatch`, async () => {
    reset();
    createdSessionPatch = { state, error: 'Claude stream-json initialization timed out' };
    await assert.rejects(
      launch(),
      /on local (failed|closed): Claude stream-json initialization timed out/,
    );
    assert.equal(
      calls.some((call) => call.method === NATIVE_WORKER_SEND),
      false,
    );
  });
}

test('native review names the actual and required checkout when its reservation differs', async () => {
  reset();
  createdSessionPatch = { cwd: '/other-checkout' };
  await assert.rejects(launch(), /workspace mismatch.*\/other-checkout.*\/source/);
  assert.equal(
    calls.some((call) => call.method === NATIVE_WORKER_SEND),
    false,
  );
});

test('retained native continuation keeps the live process and sends its operator command once', async () => {
  reset();
  await launch();
  assert(host);
  host.processStopped = false;
  const original = structuredClone(run.agentContexts![0].nativeSession!);
  const continueReview = () =>
    launchReviewWorkspaceWorker({
      runId: run.id,
      project: {},
      prompt: 'Repair the retained output.',
      resumeCommandId: 'operator-continuation',
      deadline: Date.now() + 10000,
      assertCurrent: () => {},
    });
  await continueReview();
  await continueReview();
  assert.equal(creations, 1);
  assert.equal(turns, 2);
  assert.equal(calls.filter((call) => call.method === NATIVE_WORKER_RESUME).length, 0);
  assert.equal(run.agentContexts![0].nativeSession!.sessionId, original.sessionId);
  assert.equal(run.agentContexts![0].nativeSession!.leaseId, original.leaseId);
  assert.equal(run.agentContexts![0].runnerSessionId, 'saved-conversation');
});

test('stopped native continuation resumes its exact saved conversation through the shared API', async (t) => {
  reset();
  await launch();
  assert(host);
  host.state = 'closed';
  host.processStopped = true;
  run.agentContexts![0].nativeSession!.closedAt = '2026-11-10T00:00:00Z';
  const original = structuredClone(run.agentContexts![0].nativeSession!);
  faultOnce(NATIVE_WORKER_RESUME);
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  advanceDelay = (ms) => {
    clock += ms;
  };
  t.after(() => {
    advanceDelay = undefined;
  });
  await launchReviewWorkspaceWorker({
    runId: run.id,
    project: {},
    prompt: 'Repair the retained output.',
    resumeCommandId: 'operator-resume',
    deadline: Date.now() + 10000,
    assertCurrent: () => {},
  });
  const resumes = calls.filter((call) => call.method === NATIVE_WORKER_RESUME);
  assert.equal(resumes.length, 2);
  assert.deepEqual(resumes[0].params, resumes[1].params);
  assert.equal(resumes[0].params.resumeSessionId, 'saved-conversation');
  assert.equal(run.agentContexts![0].nativeSession!.sessionId, original.sessionId);
  assert.equal(run.agentContexts![0].nativeSession!.leaseId, original.leaseId);
  assert.equal(run.agentContexts![0].nativeSession!.generation, 'resumed-generation');
  assert.equal(run.agentContexts![0].nativeSession!.closedAt, undefined);
  assert.equal(turns, 2);
  assert.equal(creations, 1);
});

test('cancellation fences a stopped reviewer resume whose successful host reply was lost', async () => {
  reset();
  await launch();
  assert(host);
  host.state = 'closed';
  host.processStopped = true;
  run.agentContexts![0].nativeSession!.closedAt = '2026-11-10T00:00:00Z';
  transportFault = (call) => {
    if (call.method === NATIVE_WORKER_RESUME) {
      run.status = 'cancelled';
      throw new NodeTransportUnavailableError('host', 'timeout', 'lost resume reply');
    }
  };
  await assert.rejects(
    launchReviewWorkspaceWorker({
      runId: run.id,
      project: {},
      prompt: 'Continue.',
      resumeCommandId: 'cancel-pending',
      deadline: Date.now() + 10000,
      assertCurrent: () => {},
    }),
    /no longer admitted/,
  );
  transportFault = undefined;
  await cancelReviewWorkspaceWorker(run.id);
  const cancel = calls.filter((call) => call.method === NATIVE_WORKER_CANCEL).at(-1);
  assert.equal(cancel?.params.resumeCommandId, 'cancel-pending');
  assert.equal(run.agentContexts![0].nativeSession!.recovery, undefined);
  assert.equal(host.processStopped, true);
});
