import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import { NATIVE_WORKER_INTERRUPT, NATIVE_WORKER_READ } from '@farmslot/agent-runtime/native';
import { Methods, type NativeSessionReadResult, type Principal } from '@farmslot/protocol';

const home = mkdtempSync(path.join(tmpdir(), 'worker-supervision-'));
process.env.FARMSLOT_HOME = home;
process.env.FARMSLOT_RUNS_DIR = path.join(home, 'runs');
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'runner-service';
after(async () => {
  await persistRunNow(run, 'supervision test teardown');
  rmSync(home, { recursive: true, force: true });
});

await import('../../runtime/mock-pty.test-support.js');
const node = await import('./node.js');
const calls: Array<{ owner: string; method: string; params: Record<string, unknown> }> = [];
let afterRead: (() => void) | undefined;
let wrongResponseOwner = false;
mock.module('./node.js', {
  namedExports: {
    ...node,
    routeNativeExecution: async (
      owner: string,
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push({ owner, method, params });
      if (method !== NATIVE_WORKER_READ) return { interrupted: true };
      afterRead?.();
      return {
        ...snapshot,
        session: {
          ...snapshot.session,
          ownerPrincipalId: wrongResponseOwner ? 'person-admin' : owner,
        },
      } satisfies NativeSessionReadResult;
    },
  },
});
const { createRun, updateRun, persistRunNow } = await import('../../runs/store.js');
const { runWithSessionOriginator } = await import('../../security/work-originator.js');
const { nativeSessionRoute } = await import('../../methods/native-session.js');
const service: Principal = {
  id: 'runner-service',
  subject: { type: 'service', displayName: 'Runner' },
  roles: [{ role: 'admin', scope: { kind: 'global' } }],
};
const admin: Principal = {
  ...service,
  id: 'person-admin',
  subject: { type: 'person', displayName: 'Admin' },
};
const run = runWithSessionOriginator(service, () =>
  createRun({
    project: 'supervision-fixture',
    flowType: 'dev',
    ticketOrPr: 'SUPERVISION',
    transport: 'native',
  }),
);
const binding = {
  sessionId: 'session',
  leaseId: 'lease',
  generation: 'generation',
  commandId: 'command',
  executionNodeId: 'local',
  ownerPrincipalId: service.id,
  acceptedAt: new Date().toISOString(),
};
const context = {
  id: 'dev',
  role: 'dev' as const,
  label: 'Dev',
  status: 'working' as const,
  runId: run.id,
  slotId: null,
  nativeSession: binding,
};
updateRun(run.id, {
  status: 'monitoring',
  agentContexts: [context],
  reviewWorkspace: {
    workspaceId: 'workspace',
    machine: 'fixture',
    executionNodeId: 'local',
    checkoutPath: home,
    taskPath: home,
    artifactPath: home,
  },
});
const target = {
  runId: run.id,
  contextId: context.id,
  generation: binding.generation,
  leaseId: binding.leaseId,
};
const params = { sessionId: binding.sessionId, executionNodeId: 'local', worker: target };
const snapshot: NativeSessionReadResult = {
  session: {
    id: binding.sessionId,
    generation: binding.generation,
    hostPid: 1,
    runner: 'codex',
    nativeSessionId: 'conversation',
    ownerPrincipalId: service.id,
    executionNodeId: 'local',
    accountContextId: 'account',
    cwd: home,
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
  commands: [],
  events: [],
  pendingRequests: [],
  cursor: 0,
  hasMore: false,
  scope: { leaseId: binding.leaseId, startAfter: 0, endAt: 0, released: false },
};

test('admin person attaches and controls a service worker without changing native identity or stale guards', async () => {
  const read = () =>
    runWithSessionOriginator(admin, () =>
      nativeSessionRoute(Methods.NATIVE_SESSION_READ, params, admin),
    );
  const interrupt = (worker = target) =>
    runWithSessionOriginator(admin, () =>
      nativeSessionRoute(Methods.NATIVE_SESSION_INTERRUPT, { ...params, worker }, admin),
    );
  const result = (await read()) as NativeSessionReadResult;
  assert.equal(result.session.ownerPrincipalId, service.id);
  assert.deepEqual(await interrupt(), { interrupted: true });
  assert.deepEqual(
    calls.map(({ owner, method }) => ({ owner, method })),
    [
      { owner: service.id, method: NATIVE_WORKER_READ },
      { owner: service.id, method: NATIVE_WORKER_INTERRUPT },
    ],
  );
  const before = calls.length;
  await assert.rejects(interrupt({ ...target, leaseId: 'stale' }), /stale/);
  await assert.rejects(interrupt({ ...target, generation: 'stale' }), /stale/);
  const otherService: Principal = { ...service, id: 'other-service' };
  await assert.rejects(
    runWithSessionOriginator(otherService, () =>
      nativeSessionRoute(Methods.NATIVE_SESSION_READ, params, otherService),
    ),
    /another principal/,
  );
  assert.equal(calls.length, before);
  wrongResponseOwner = true;
  await assert.rejects(read(), /history scope changed/);
  wrongResponseOwner = false;
  afterRead = () => {
    updateRun(run.id, {
      agentContexts: [
        { ...context, nativeSession: { ...binding, closedAt: new Date().toISOString() } },
      ],
    });
    updateRun(run.id, {
      agentContexts: [{ ...context, nativeSession: { ...binding, leaseId: 'successor' } }],
    });
  };
  await assert.rejects(read(), /stale/);
  assert.equal(run.nativeOwnerPrincipalId, service.id);
});
