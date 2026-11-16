import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import { NATIVE_WORKER_ENSURE, NATIVE_WORKER_STATE } from '@farmslot/agent-runtime/native';
import { nativeHostUnavailableError } from '@farmslot/agent-runtime/native/host-unavailable';
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
const vars = makeVars({ slotId: 'restart-slot', remoteRepo: '/owned/repo', repo: '/owned/repo' });
let run: Run;
/** Replies the host gives, in order: a restart, then the host that came back. */
let hostDown: number;
let ensureFailure: Error | undefined;
let session: NativeSessionInfo | undefined;
const calls: string[] = [];
let onProbe: (() => void) | undefined;
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
      const existing = run.agentContexts!.find((value) => value.id === patch.id);
      if (!existing) throw new Error('No reservation to patch');
      const resolved = options?.resolvePatch ? options.resolvePatch(existing) : patch;
      if (!resolved) return null;
      Object.assign(existing, resolved);
      return existing;
    },
  },
});
mock.module('./worker-launch.js', {
  namedExports: { prepareNativeWorkerLaunch: async () => ({ launch }) },
});
mock.module('../../run-engine/worker-launch-preflight.js', {
  namedExports: {
    WorkerLaunchInputsChangedError: class extends Error {},
    admitWorkerLaunch: async () => async () => {},
  },
});
mock.module('./node.js', {
  namedExports: {
    ...node,
    routeNativeExecution: async (_owner: string, method: string) => {
      calls.push(method);
      if (method === Methods.NATIVE_SESSION_LIST) {
        onProbe?.();
        // The host is down for the launch's own preflight and for the probes after it.
        if (hostDown > 0) {
          hostDown -= 1;
          throw nativeHostUnavailableError('/root/host.log');
        }
        return { sessions: session ? [session] : [] };
      }
      if (method === NATIVE_WORKER_STATE) return { stateDirectory: '/owned/state' };
      if (method === NATIVE_WORKER_ENSURE) {
        if (ensureFailure) throw ensureFailure;
        session = hostInfo();
        return { session };
      }
      // The launch got past ENSURE; what it does with a live worker is tested elsewhere.
      throw new Error('Reached post-ENSURE boundary');
    },
  },
});
const hostWait = await import('./host-wait.js');
/** A test clock: the wait's own sleeps are what it spends. */
let clock = 0;
mock.module('./host-wait.js', {
  namedExports: {
    ...hostWait,
    waitForNativeHostReady: (input: Parameters<typeof hostWait.waitForNativeHostReady>[0]) =>
      hostWait.waitForNativeHostReady({
        ...input,
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
      }),
  },
});
const { dispatchNativeWorker } = await import('./worker.js');
function hostInfo(overrides: Partial<NativeSessionInfo> = {}): NativeSessionInfo {
  return {
    id: 'restart-session',
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
    ...overrides,
  };
}
beforeEach(() => {
  run = makeRun({
    id: 'host-restart',
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
        sessionId: 'restart-session',
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
  calls.length = 0;
  clock = 0;
  hostDown = 0;
  session = undefined;
  ensureFailure = undefined;
  onProbe = undefined;
});
const dispatch = (extra: Partial<Parameters<typeof dispatchNativeWorker>[0]> = {}) =>
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
    },
    emit: () => {},
    ...extra,
  });
const ensures = () => calls.filter((call) => call === NATIVE_WORKER_ENSURE).length;

test('a host restarting mid-launch is waited out, and the launch sends ENSURE once more', async () => {
  // The preflight list and the first two probes find no host; the third one answers.
  hostDown = 3;
  await assert.rejects(dispatch(), /Reached post-ENSURE boundary/);
  assert.equal(ensures(), 1, 'ENSURE is sent once, after the host answers');
  assert.equal(clock, 2_000, 'the wait spent two probe intervals');
  assert.deepEqual(calls, [
    // The preflight's own list, the three probes, then the preflight again: the
    // launch re-reads host state before it runs anything on the host that came back.
    Methods.NATIVE_SESSION_LIST,
    Methods.NATIVE_SESSION_LIST,
    Methods.NATIVE_SESSION_LIST,
    Methods.NATIVE_SESSION_LIST,
    Methods.NATIVE_SESSION_LIST,
    'runtime-ready',
    NATIVE_WORKER_ENSURE,
    Methods.NATIVE_SESSION_READ,
  ]);
});

test('ENSURE refused by a host that never answered is retried once after the wait', async () => {
  ensureFailure = nativeHostUnavailableError('/root/host.log');
  onProbe = () => {
    // The host comes back between the refused ENSURE and the next probe.
    if (ensures() > 0) ensureFailure = undefined;
  };
  await assert.rejects(dispatch(), /Reached post-ENSURE boundary/);
  assert.equal(ensures(), 2, 'the refused send plus one retry');
  assert.equal(run.agentContexts![0].nativeSession?.sessionId, 'restart-session');
});

test('a host that never comes back refuses the launch with the wait named', async () => {
  ensureFailure = nativeHostUnavailableError('/root/host.log');
  hostDown = 500;
  await assert.rejects(dispatch(), (error: Error) => {
    assert.match(error.message, /Native worker launch is unconfirmed/);
    assert.match(error.message, /stayed unavailable: waited 120 s of 120 s/);
    return true;
  });
  assert.equal(ensures(), 0, 'the preflight never got to send anything');
  assert.equal(clock, hostWait.NATIVE_HOST_WAIT_MS);
});

test('a step with less budget than the ceiling waits only that long', async () => {
  ensureFailure = nativeHostUnavailableError('/root/host.log');
  hostDown = 500;
  await assert.rejects(
    dispatch({ hostWaitBudgetMs: 5_000 }),
    /stayed unavailable: waited 5 s of 5 s/,
  );
  assert.equal(clock, 5_000);
});

test('a cancelled run ends the wait instead of holding its slot for the window', async () => {
  ensureFailure = nativeHostUnavailableError('/root/host.log');
  // The host stays down, so only the cancel can end this wait.
  hostDown = 500;
  let probes = 0;
  onProbe = () => {
    // Cancelled while the wait is already running, not before it starts.
    if (probes++ === 1) run.status = 'cancelled';
  };
  await assert.rejects(dispatch(), /no longer admitted|cancelled/);
  assert.equal(ensures(), 0);
  assert.equal(clock, 1_000, 'one probe interval, not the window');
});

test('a refusal that is not a host that never answered is not waited out', async () => {
  ensureFailure = new Error('Native worker reservation belongs to another execution context');
  await assert.rejects(dispatch(), /belongs to another execution context/);
  assert.equal(ensures(), 1);
  assert.equal(clock, 0, 'nothing is spent waiting');
});
