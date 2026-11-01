import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, mock, test } from 'node:test';

import { NATIVE_WORKER_ENSURE, NATIVE_WORKER_STATE } from '@farmslot/agent-runtime/native';
import {
  type NativeWorkerLaunch,
  nativeWorkerLaunchDigest,
} from '@farmslot/agent-runtime/native/worker-launch';
import {
  type AgentContext,
  contextIdFor,
  Methods,
  type NativeSessionInfo,
  type Run,
} from '@farmslot/protocol';

await import('../../runtime/mock-pty.test-support.js');
const core = await import('../../core/index.js');
const slotIO = await import('../../core/slot-io.js');
const node = await import('./node.js');
const agents = await import('../../agents/contexts.js');
const store = await import('../../runs/store.js');
const owners = await import('../../security/native-worker-owner.js');
const { makeRun } = await import('../../run-engine/test-fixtures.js');
const { makeVars } = await import('../test-fixtures.js');
const launch: NativeWorkerLaunch = {
  leaseId: 'lease',
  safetyTier: 'sandboxed',
  environment: { set: {}, unset: [] },
};
const vars = makeVars({ slotId: 'runtime-slot', remoteRepo: '/owned/repo', repo: '/owned/repo' });
const stop = new Error('Reached ENSURE boundary');
let run: Run;
let host: NativeSessionInfo | undefined;
let runtimeError: string | undefined;
let listUnavailable: boolean;
let afterList: (() => void) | undefined;
const calls: string[] = [];
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    readSlotRow: async () => ({ current_run_id: run.id, phase: 'dispatching' }),
  },
});
mock.module('../../core/slot-io.js', {
  namedExports: { ...slotIO, slotRealpath: async (_vars: unknown, file: string) => file },
});
mock.module('../../security/native-worker-owner.js', {
  namedExports: { ...owners, assertNativeRunOwner: () => {} },
});
mock.module('../../runs/store.js', {
  namedExports: {
    ...store,
    getRun: () => run,
    updateRun: (_id: string, patch: Partial<Run>) => Object.assign(run, patch),
    persistRunNow: async () => {},
  },
});
mock.module('../../agents/contexts.js', {
  namedExports: {
    ...agents,
    upsertAgentContext: async (
      _id: string,
      _role: string,
      patch: Partial<AgentContext>,
      options?: {
        resolvePatch?: (existing: AgentContext | undefined) => Partial<AgentContext> | null;
      },
    ) => {
      const existing = run.agentContexts!.find((value) => value.id === patch.id)!;
      const resolved = options?.resolvePatch ? options.resolvePatch(existing) : patch;
      if (!resolved) return null;
      Object.assign(existing, resolved);
      return existing;
    },
  },
});
const launchInputs: Array<{ taskLibraries?: ReadonlyMap<string, string> }> = [];
mock.module('./worker-launch.js', {
  namedExports: {
    prepareNativeWorkerLaunch: async (input: { taskLibraries?: ReadonlyMap<string, string> }) => {
      launchInputs.push(input);
      return { launch };
    },
  },
});
// A pool or project rewrite during preflight: the launch's later admission checks refuse.
let inputsChanged = false;
class WorkerLaunchInputsChangedError extends Error {}
mock.module('../../run-engine/worker-launch-preflight.js', {
  namedExports: {
    WorkerLaunchInputsChangedError,
    admitWorkerLaunch: async () => async () => {
      if (inputsChanged) throw new WorkerLaunchInputsChangedError('Worker launch inputs changed');
    },
  },
});
mock.module('./node.js', {
  namedExports: {
    ...node,
    routeNativeExecution: async (_owner: string, method: string) => {
      calls.push(method);
      if (method === Methods.NATIVE_SESSION_LIST) {
        afterList?.();
        return {
          sessions: host ? [host] : [],
          ...(listUnavailable
            ? { unavailableExecutionNodes: [{ executionNodeId: 'local', message: 'offline' }] }
            : {}),
        };
      }
      if (method === NATIVE_WORKER_STATE) return { stateDirectory: '/owned/state' };
      if (method === NATIVE_WORKER_ENSURE) throw stop;
      throw new Error('Unexpected native operation: ' + method);
    },
  },
});
const { dispatchNativeWorker } = await import('./worker.js');
beforeEach(() => {
  run = makeRun({
    id: 'pending-runtime',
    transport: 'native',
    nativeOwnerPrincipalId: 'owner',
    slotId: vars.slotId,
    status: 'dispatching',
  });
  Object.assign(run, { transport: 'native', nativeOwnerPrincipalId: 'owner' });
  run.agentContexts = [
    {
      id: contextIdFor('primary'),
      runId: run.id,
      slotId: vars.slotId,
      role: 'primary',
      label: 'Primary',
      status: 'launching',
      taskFile: 'tasks/proof/TASK.md',
      runner: 'claude',
      model: 'sonnet',
      nativeSession: {
        sessionId: 'pending-session',
        ownerPrincipalId: 'owner',
        executionNodeId: 'local',
        leaseId: 'lease',
        commandId: 'command',
        stateDirectory: '/owned/state',
        launchDigest: nativeWorkerLaunchDigest(launch),
        safetyTier: 'sandboxed',
      },
    },
  ];
  host = undefined;
  runtimeError = undefined;
  listUnavailable = false;
  afterList = undefined;
  inputsChanged = false;
  calls.length = 0;
  launchInputs.length = 0;
});
const reservation = () => run.agentContexts![0].nativeSession;
const dispatch = () =>
  dispatchNativeWorker({
    runId: run.id,
    vars,
    role: 'primary',
    taskId: 'proof',
    taskFile: 'tasks/proof/TASK.md',
    signalFile: 'tasks/proof/SIGNAL.json',
    runner: 'claude',
    model: 'sonnet',
    safetyTier: 'sandboxed',
    project: {},
    beforeInput: async () => {},
    beforeFreshLaunch: async () => {
      calls.push('runtime-ready');
      if (runtimeError) throw new Error(runtimeError);
    },
    emit: () => {},
  });

test('pending reservation retry checks runtime before ENSURE can create a worker', async () => {
  await assert.rejects(dispatch(), /Reached ENSURE boundary/);
  assert.deepEqual(calls, [Methods.NATIVE_SESSION_LIST, 'runtime-ready', NATIVE_WORKER_ENSURE]);
});
for (const reason of ['stopped runtime failed to boot', 'unknown browser health'])
  test(`pending reservation refuses ${reason} before ENSURE`, async () => {
    runtimeError = reason;
    await assert.rejects(dispatch(), new RegExp(reason));
    assert.deepEqual(calls, [Methods.NATIVE_SESSION_LIST, 'runtime-ready']);
  });
test('an unconfirmed reply with an existing worker does not boot retained runtime', async () => {
  host = {
    id: 'pending-session',
    ownerPrincipalId: 'owner',
    executionNodeId: 'local',
    workerManaged: true,
    workerLeaseId: 'lease',
    generation: 'generation',
    hostPid: 1,
    nativeSessionId: 'native-conversation',
    runner: 'claude',
    cwd: '/owned/repo',
    executable: 'claude',
    version: 'fixture',
    mode: 'default',
    accountMode: 'native',
    accountContextId: 'fixture',
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
  };
  await assert.rejects(dispatch(), /Reached ENSURE boundary/);
  assert.deepEqual(calls, [Methods.NATIVE_SESSION_LIST, NATIVE_WORKER_ENSURE]);
});
test('unavailable host presence and cancelled observations never authorize ENSURE', async () => {
  listUnavailable = true;
  await assert.rejects(dispatch(), /presence is unavailable/);
  assert.deepEqual(calls, [Methods.NATIVE_SESSION_LIST]);
  listUnavailable = false;
  afterList = () => {
    run.status = 'cancelled';
  };
  calls.length = 0;
  await assert.rejects(dispatch(), /no longer admitted/);
  assert.deepEqual(calls, [Methods.NATIVE_SESSION_LIST]);
});
test('a rewrite during LIST retires the unsent reservation, so the retry ENSUREs once on fresh inputs', async () => {
  afterList = () => {
    inputsChanged = true;
  };
  await assert.rejects(dispatch(), WorkerLaunchInputsChangedError);
  assert.deepEqual(calls, [Methods.NATIVE_SESSION_LIST]);
  assert.equal(reservation(), undefined, 'the host never had it');
  // The engine's one retry re-reads the inputs and reserves fresh.
  afterList = undefined;
  inputsChanged = false;
  calls.length = 0;
  await assert.rejects(dispatch(), /Reached ENSURE boundary/);
  assert.deepEqual(calls, [
    NATIVE_WORKER_STATE,
    Methods.NATIVE_SESSION_LIST,
    'runtime-ready',
    NATIVE_WORKER_ENSURE,
  ]);
  assert.notEqual(reservation()?.sessionId, 'pending-session');
});
test('a rewrite while the host may hold the reservation keeps it for reconciliation', async () => {
  listUnavailable = true;
  afterList = () => {
    inputsChanged = true;
  };
  await assert.rejects(
    dispatch(),
    (error: Error) => error.name === 'NativeWorkerOperationUncertainError',
  );
  assert.equal(reservation()?.sessionId, 'pending-session');
});
test('a bound run launches its native worker on the libraries its task pinned', async (t) => {
  const taskDir = mkdtempSync(path.join(tmpdir(), 'native-pinned-libraries-'));
  t.after(() => rmSync(taskDir, { recursive: true, force: true }));
  const pin = '/home/.farmslot/task-pins/ba9f77';
  mkdirSync(path.join(taskDir, 'artifacts'));
  writeFileSync(
    path.join(taskDir, 'artifacts/harness-provenance.json'),
    JSON.stringify({
      pin,
      bindingIdentity: { libraries: [{ name: 'perps', path: `${pin}/inputs/39/recipe-perps` }] },
    }),
  );
  run.taskFile = path.join(taskDir, 'TASK.md');
  await assert.rejects(dispatch(), /Reached ENSURE boundary/);
  assert.deepEqual(
    [...(launchInputs[0]?.taskLibraries ?? [])],
    [['perps', `${pin}/inputs/39/recipe-perps`]],
  );
});
