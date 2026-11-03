import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import { WebSocket } from 'ws';

import { Methods, type NativeSessionInfo, type Run } from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'native-admin-delegation-'));
after(() => rm(root, { recursive: true, force: true }));
for (const dir of ['scripts', 'services/gateway', 'pool'])
  await mkdir(path.join(root, dir), { recursive: true });
await writeFile(path.join(root, 'CLAUDE.md'), '# Fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
  FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: '',
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
const { createGatewayAuthRuntime } = await import('../security/auth.js');
const { runWithSessionOriginator, currentSessionOriginator } =
  await import('../security/work-originator.js');
const { registerNode, unregisterByWs } = await import('../fleet/machine-registry.js');
const { handleNodeResponse } = await import('../fleet/node-rpc.js');
const { nativeSessionManager } = await import('../runners/native/manager.js');
const { nativeSessionRoute } = await import('./native-session.js');
const { authorizeNativeObservation, GatewayNativeObservations, nativeObservations } =
  await import('../resources/native-observations.js');
const { resolveStaticReviewOwner } = await import('../security/native-worker-owner.js');
const { nativeReviewerOwner } = await import('../runners/native/review-owner.js');
const { supervisedPublicationOwner } = await import('../review-publication/supervision.js');
const { loadSlotVars } = await import('../core/config.js');
const { makeRun } = await import('../run-engine/test-fixtures.js');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: process.env.FARMSLOT_HOME });
const admin = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
const farm = auth.writer.createPrincipal(
  { type: 'service', displayName: 'Automation' },
  admin,
  'farm-automation',
);
auth.writer.issueCredential(farm.id, 'Fixture bootstrap');
auth.writer.createPrincipal({ type: 'person', displayName: 'Arthur' }, admin, 'arthur');
auth.writer.retirePrincipals(['arthur']);
const arthur = auth.writer.createPrincipal(
  { type: 'person', displayName: 'Arthur' },
  admin,
  'arthur',
  { reuseRetiredId: true },
);
const nodeOwner = auth.writer.createPrincipal(
  { type: 'person', displayName: 'Existing node owner' },
  admin,
);
const outsider = auth.writer.createPrincipal({ type: 'person', displayName: 'No authority' }, []);
const machines = ['macwork', 'macpro', 'mini'] as const;
const owners = { macwork: nodeOwner.id, macpro: farm.id, mini: farm.id };
const homes = {
  macwork: '/Users/native-person',
  macpro: '/Users/farm',
  mini: '/Volumes/Data/operator',
};
const sessions = new Map<string, NativeSessionInfo>();
const mutations: string[] = [];
let worker = false;
let hostSupportsDelegation = true;
const sockets = new Map<string, WebSocket>();
let holdMetadataReply: ((machine: string, reply: () => void) => void) | undefined;
let holdListReply: ((machine: string, reply: () => void) => void) | undefined;
const receipts = new Map(
  machines.map((nodeId) => [
    nodeId,
    {
      version: 1 as const,
      nodeId,
      ownerId: owners[nodeId],
      incarnation: nodeId,
      revision: 0,
      ready: true,
    },
  ]),
);
for (const machine of machines) {
  const principal = auth.writer.createPrincipal(
    { type: 'node', displayName: machine, machine, nativeOwnerPrincipalId: owners[machine] },
    [],
    `node-${machine}`,
  );
  auth.writer.issueCredential(principal.id, 'Fixture node');
  await writeFile(
    path.join(root, 'pool', `${machine}.json`),
    JSON.stringify({
      machine,
      host: machine === 'macwork' ? 'localhost' : `${machine}.invalid`,
      ssh_user: 'guessed',
      os: 'macos',
      project: 'fixture',
      slots: [{ id: `${machine}-slot`, repo: '~/project', session: machine }],
    }),
  );
  const socket = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      const frame = JSON.parse(raw);
      if (frame.method === 'native.session.metadata') {
        assert.deepEqual(frame.params, { owner: owners[machine] });
        const reply = () =>
          handleNodeResponse(
            frame.id,
            true,
            { homeDirectory: homes[machine], supportsStandaloneDelegation: hostSupportsDelegation },
            undefined,
            undefined,
            socket,
          );
        if (holdMetadataReply) holdMetadataReply(machine, reply);
        else reply();
        return;
      }
      if (frame.method === 'exec') {
        handleNodeResponse(
          frame.id,
          true,
          { exitCode: 0, stdout: '[]', stderr: '' },
          undefined,
          undefined,
          socket,
        );
        return;
      }
      assert.equal(frame.method, 'native.session');
      assert.equal(frame.params.owner, owners[machine]);
      const params = frame.params.params;
      let result: unknown;
      if (frame.params.method === Methods.NATIVE_PROFILE_LIST) {
        result = { profiles: [] };
      } else if (frame.params.method === Methods.NATIVE_SESSION_CREATE) {
        assert.equal(params.runner, 'codex');
        mutations.push('create');
        assert.deepEqual(frame.params.requester, { principalId: 'arthur', principalGeneration: 1 });
        const info: NativeSessionInfo = {
          id: `${machine}-session`,
          generation: 'generation',
          hostPid: 1,
          runner: 'codex',
          nativeSessionId: 'conversation',
          ownerPrincipalId: owners[machine],
          executionNodeId: machine,
          accountContextId: machine,
          cwd: params.cwd,
          executable: 'codex',
          version: 'fixture',
          mode: 'default',
          accountMode: 'native',
          state: 'idle',
          capabilities: {
            modes: ['default'],
            streaming: true,
            tools: true,
            approvals: true,
            questions: true,
            interrupt: true,
            resume: true,
          },
          requestedByPrincipalId: frame.params.requester.principalId,
          requestedByPrincipalGeneration: frame.params.requester.principalGeneration,
        };
        sessions.set(machine, info);
        result = { session: info };
      } else if (frame.params.method === Methods.NATIVE_SESSION_LIST) {
        result = {
          sessions: sessions.has(machine)
            ? [{ ...sessions.get(machine), workerManaged: worker }]
            : [],
        };
      } else if (frame.params.method === Methods.NATIVE_SESSION_READ) {
        result = {
          session: { ...sessions.get(machine), workerManaged: worker },
          events: [],
          cursor: 0,
          hasMore: false,
          commands: [],
          pendingRequests: [],
        };
      } else if (frame.params.method === Methods.NATIVE_SESSION_CLOSE) {
        mutations.push('close');
        const info = sessions.get(machine);
        assert(info);
        info.state = 'closed';
        result = { session: info };
      } else if (frame.params.method === Methods.NATIVE_SESSION_SEND) {
        mutations.push('send');
        result = {
          commandId: params.commandId,
          state: 'accepted',
          submitted: true,
          accepted: true,
        };
      } else assert.fail(`Unexpected method ${frame.params.method}`);
      const reply = () =>
        handleNodeResponse(
          frame.id,
          true,
          frame.params.observe ? { value: result, nativeSource: receipts.get(machine) } : result,
          undefined,
          undefined,
          socket,
        );
      if (frame.params.method === Methods.NATIVE_SESSION_LIST && holdListReply)
        holdListReply(machine, reply);
      else reply();
    },
  } as WebSocket;
  sockets.set(machine, socket);
  registerNode(
    machine,
    1,
    socket,
    undefined,
    undefined,
    {
      ownerPrincipalId: owners[machine],
      supportsEnsure: true,
      supportsWorkers: true,
      supportsProfiles: true,
      supportsObservations: true,
      supportsStandaloneDelegation: true,
    },
    { principalId: principal.id, valid: () => true },
  );
}
after(() => {
  for (const socket of sockets.values()) unregisterByWs(socket);
});
const call = (method: string, params: Record<string, unknown>) =>
  runWithSessionOriginator(arthur, () => nativeSessionRoute(method, params, arthur));

for (const machine of machines)
  test(`generation-one Arthur creates, reads, sends and closes on ${machine} under its configured owner`, async () => {
    assert.equal(arthur.generation, 1);
    const cwd = `${homes[machine]}/custom`;
    const created = await call(Methods.NATIVE_SESSION_CREATE, {
      executionNodeId: machine,
      cwd,
      runner: 'codex',
    });
    assert(created && typeof created === 'object' && 'session' in created);
    const info = Reflect.get(created, 'session');
    assert(info && typeof info === 'object');
    assert.equal(Reflect.get(info, 'ownerPrincipalId'), owners[machine]);
    assert.equal(Reflect.get(info, 'requestedByPrincipalId'), 'arthur');
    assert.equal(Reflect.get(info, 'requestedByPrincipalGeneration'), 1);
    await call(Methods.NATIVE_SESSION_READ, {
      executionNodeId: machine,
      sessionId: `${machine}-session`,
    });
    await call(Methods.NATIVE_SESSION_SEND, {
      executionNodeId: machine,
      sessionId: `${machine}-session`,
      commandId: 'command',
      text: 'Hello',
    });
    await call(Methods.NATIVE_SESSION_CLOSE, {
      executionNodeId: machine,
      sessionId: `${machine}-session`,
    });
  });

test('catalog names all targets, reads their actual homes and keeps custom paths target-bound', async () => {
  const catalog = await call(Methods.NATIVE_SESSION_CATALOG, {});
  assert(catalog && typeof catalog === 'object');
  assert.deepEqual(
    Reflect.get(catalog, 'executionNodes'),
    machines.map((machine) => ({
      executionNodeId: machine,
      label: machine,
      homeDirectory: homes[machine],
    })),
  );
  const contexts = Reflect.get(catalog, 'contexts');
  for (const machine of machines)
    assert.ok(
      contexts.some(
        (c: { slotId?: string; cwd: string; executionNodeId: string }) =>
          c.slotId === `${machine}-slot` &&
          c.cwd === `${homes[machine]}/project` &&
          c.executionNodeId === machine,
      ),
    );
});

test('gateway-local journals remain discoverable separately from the same-host node', async () => {
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = farm.id;
  const local = {
    ...sessions.get('macwork')!,
    id: 'local-session',
    executionNodeId: 'local',
    ownerPrincipalId: farm.id,
  };
  const list = mock.method(nativeSessionManager, 'list', async () => [local]);
  try {
    const catalog = await call(Methods.NATIVE_SESSION_CATALOG, {});
    assert(catalog && typeof catalog === 'object');
    assert.deepEqual(
      Reflect.get(catalog, 'executionNodes').find(
        (row: { executionNodeId: string }) => row.executionNodeId === 'local',
      ),
      {
        executionNodeId: 'local',
        label: 'local',
        homeDirectory: os.homedir(),
      },
    );
    const inventory = await call(Methods.NATIVE_SESSION_LIST, {});
    assert(inventory && typeof inventory === 'object');
    assert(
      Reflect.get(inventory, 'sessions').some((row: NativeSessionInfo) => row.id === local.id),
    );
    const authority = await authorizeNativeObservation(arthur, {
      key: { family: 'native-session', scope: 'owner', ownerId: arthur.id },
      method: Methods.NATIVE_SESSION_LIST,
      params: {},
    });
    assert.equal(authority.owners?.local, farm.id);
    assert(authority.nodes.includes('macwork'));
  } finally {
    list.mock.restore();
    process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = '';
  }
});

for (const method of [Methods.NATIVE_SESSION_LIST, Methods.NATIVE_SESSION_CATALOG])
  for (const change of ['connection', 'owner'] as const)
    test(`${method} fences a completed page after a target ${change} change`, async () => {
      const local = {
        ...sessions.get('macwork')!,
        id: 'local-session',
        executionNodeId: 'local',
        ownerPrincipalId: farm.id,
      };
      const localList = mock.method(nativeSessionManager, 'list', async () => [local]);
      if (change === 'owner') process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = farm.id;
      let releaseSlow: (() => void) | undefined;
      let fastDone!: () => void;
      let slowStarted!: () => void;
      const fast = new Promise<void>((resolve) => {
        fastDone = resolve;
      });
      const slow = new Promise<void>((resolve) => {
        slowStarted = resolve;
      });
      const hold = (machine: string, reply: () => void) => {
        if (machine === 'mini') {
          releaseSlow = reply;
          slowStarted();
        } else {
          reply();
          if (machine === 'macpro') fastDone();
        }
      };
      try {
        if (method === Methods.NATIVE_SESSION_LIST) holdListReply = hold;
        else holdMetadataReply = hold;
        const pending = call(method, {});
        await Promise.all([fast, slow]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (change === 'owner') process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = nodeOwner.id;
        else
          registerNode(
            'macpro',
            1,
            sockets.get('macpro')!,
            undefined,
            undefined,
            { ownerPrincipalId: farm.id, supportsStandaloneDelegation: true },
            { principalId: 'node-macpro', valid: () => true },
          );
        assert(releaseSlow);
        releaseSlow();
        const result = await pending;
        assert(result && typeof result === 'object');
        const target = change === 'owner' ? 'local' : 'macpro';
        if (method === Methods.NATIVE_SESSION_LIST) {
          assert(
            !Reflect.get(result, 'sessions').some(
              (row: NativeSessionInfo) => row.executionNodeId === target,
            ),
          );
          assert(
            Reflect.get(result, 'unavailableExecutionNodes').some(
              (row: { executionNodeId: string }) => row.executionNodeId === target,
            ),
          );
        } else {
          assert(
            !Reflect.get(result, 'contexts').some(
              (row: { executionNodeId: string }) => row.executionNodeId === target,
            ),
          );
          assert.match(
            Reflect.get(result, 'executionNodes').find(
              (row: { executionNodeId: string }) => row.executionNodeId === target,
            ).unavailableReason,
            /changed/,
          );
        }
      } finally {
        holdListReply = undefined;
        holdMetadataReply = undefined;
        localList.mock.restore();
        process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = '';
        releaseSlow?.();
        registerNode(
          'macpro',
          1,
          sockets.get('macpro')!,
          undefined,
          undefined,
          {
            ownerPrincipalId: farm.id,
            supportsStandaloneDelegation: true,
            supportsEnsure: true,
            supportsWorkers: true,
            supportsProfiles: true,
            supportsObservations: true,
          },
          { principalId: 'node-macpro', valid: () => true },
        );
      }
    });

test('standalone worker bypasses and caller-supplied attribution are refused before mutation', async () => {
  const before = mutations.length;
  worker = true;
  try {
    for (const method of [
      Methods.NATIVE_SESSION_READ,
      Methods.NATIVE_SESSION_SEND,
      Methods.NATIVE_SESSION_CLOSE,
    ])
      await assert.rejects(
        call(method, {
          executionNodeId: 'macpro',
          sessionId: 'macpro-session',
          commandId: 'bad',
          text: 'bad',
        }),
        /worker|pinned/i,
      );
  } finally {
    worker = false;
  }
  for (const key of [
    'ownerId',
    'ownerPrincipalId',
    'requester',
    'requestedByPrincipalId',
    'requestedByPrincipalGeneration',
  ])
    await assert.rejects(
      call(Methods.NATIVE_SESSION_CREATE, {
        executionNodeId: 'macpro',
        runner: 'codex',
        cwd: homes.macpro,
        [key]: 'forged',
      }),
      /supplied|derived|attribution|owner/i,
    );
  await assert.rejects(
    call(Methods.NATIVE_SESSION_CREATE, {
      executionNodeId: 'macpro',
      runner: 'codex',
      cwd: homes.macpro,
      effort: '--unsafe',
    }),
    /effort/i,
  );
  await assert.rejects(
    runWithSessionOriginator(outsider, () =>
      nativeSessionRoute(
        Methods.NATIVE_SESSION_CREATE,
        { executionNodeId: 'macpro', runner: 'codex', cwd: homes.macpro },
        outsider,
      ),
    ),
    /owner|authority|admin/i,
  );
  assert.equal(mutations.length, before);
});

test('farm review, publication and request-local identity stay unchanged', async () => {
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = farm.id;
  const localList = mock.method(nativeSessionManager, 'list', async () => []);
  try {
    await runWithSessionOriginator(arthur, async () => {
      const before = currentSessionOriginator();
      const expected = {
        ownerId: farm.id,
        requester: { principalId: 'arthur', principalGeneration: 1 },
      };
      assert.deepEqual(resolveStaticReviewOwner('live'), expected);
      for (const machine of machines)
        assert.equal(
          nativeReviewerOwner(
            makeRun({ transport: 'tmux' }),
            await loadSlotVars(`${machine}-slot`),
          ),
          farm.id,
        );
      const publication: Pick<Run, 'reviewPublication' | 'prWork'> = {
        reviewPublication: {
          direct: {
            ownerId: farm.id,
            requested: true,
            pr: { host: 'github.com' as const, repo: 'fixture/repo', number: 1 },
            policy: { enabled: false, source: 'built-in' as const },
          },
          checkedAt: '2026-11-03T00:00:00Z',
        },
      };
      assert.deepEqual(supervisedPublicationOwner(publication, arthur.id, true), {
        ownerId: farm.id,
        ownerGeneration: undefined,
      });
      await nativeSessionRoute(Methods.NATIVE_SESSION_LIST, {}, arthur);
      assert.deepEqual(currentSessionOriginator(), before);
      assert.deepEqual(resolveStaticReviewOwner('live'), expected);
      assert.deepEqual(supervisedPublicationOwner(publication, arthur.id, true), {
        ownerId: farm.id,
        ownerGeneration: undefined,
      });
    });
  } finally {
    localList.mock.restore();
    process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = '';
  }
});

test('observed reads separate the generation-one reader from each configured source owner', async () => {
  const connection = {};
  const observations = new GatewayNativeObservations(() => {});
  observations.attachClient(connection, () => arthur);
  try {
    for (const machine of machines) {
      const info = sessions.get(machine)!;
      const interest = {
        key: {
          family: 'native-session' as const,
          ownerId: arthur.id,
          nodeId: machine,
          sessionId: info.id,
        },
        method: Methods.NATIVE_SESSION_READ,
        params: { executionNodeId: machine, sessionId: info.id },
        session: info,
      };
      assert.deepEqual(await authorizeNativeObservation(arthur, interest), {
        ownerId: owners[machine],
        nodes: [machine],
      });
    }
  } finally {
    observations.dispose();
  }
});

test('observed history and inventory keep reader keys while fencing all configured source owners', async () => {
  const connection = {};
  const invalidated: Array<{ ownerId: string }> = [];
  const observations = new GatewayNativeObservations((key) => invalidated.push(key));
  const reader = () => {
    const current = auth.store.findPrincipal(arthur.id);
    assert(current);
    return current;
  };
  observations.attachClient(connection, reader);
  for (const machine of machines) {
    const receipt = receipts.get(machine)!;
    observations.acceptRemote(sockets.get(machine)!, receipt, () => true);
    nativeObservations.acceptRemote(sockets.get(machine)!, receipt, () => true);
  }
  try {
    const catalogInterest = {
      key: { family: 'native-session' as const, scope: 'owner' as const, ownerId: arthur.id },
      method: Methods.NATIVE_SESSION_CATALOG,
      params: {},
    };
    const catalog = await observations.read(
      connection,
      [catalogInterest],
      () => call(Methods.NATIVE_SESSION_CATALOG, {}),
      () => ({}),
    );
    assert(catalog.payload && typeof catalog.payload === 'object');
    assert.equal(Reflect.get(catalog.payload, 'executionNodes').length, 3);
    const listInterest = { ...catalogInterest, method: Methods.NATIVE_SESSION_LIST };
    const list = await observations.read(
      connection,
      [listInterest],
      () => call(Methods.NATIVE_SESSION_LIST, {}),
      () => ({}),
    );
    assert(list.payload && typeof list.payload === 'object');
    assert.deepEqual(
      Reflect.get(list.payload, 'sessions').map(
        (session: NativeSessionInfo) => session.ownerPrincipalId,
      ),
      machines.map((machine) => owners[machine]),
    );
    for (const machine of machines) {
      const interest = {
        key: {
          family: 'native-session' as const,
          ownerId: arthur.id,
          nodeId: machine,
          sessionId: `${machine}-session`,
        },
        method: Methods.NATIVE_SESSION_READ,
        params: { executionNodeId: machine, sessionId: `${machine}-session` },
      };
      const page = await observations.read(
        connection,
        [interest],
        () => call(Methods.NATIVE_SESSION_READ, interest.params),
        () => ({}),
      );
      assert(page.payload && typeof page.payload === 'object');
      assert.equal(Reflect.get(page.payload, 'session').ownerPrincipalId, owners[machine]);
      assert.equal(await observations.canReadKey(connection, interest.key), true);
    }
    const receipt = { ...receipts.get('mini')!, revision: 1 };
    receipts.set('mini', receipt);
    observations.acceptRemote(sockets.get('mini')!, receipt, () => true);
    assert.ok(invalidated.some((key) => key.ownerId === arthur.id));
    auth.writer.revokeRole(arthur.id, 'admin', { kind: 'global' });
    assert.equal(await observations.canReadKey(connection, listInterest.key), false);
    await assert.rejects(call(Methods.NATIVE_SESSION_LIST, {}), /authority/);
  } finally {
    auth.writer.grantRole(arthur.id, 'admin', { kind: 'global' });
    observations.dispose();
  }
});

test('an old native host stays visible with its real home and an explicit refresh reason', async () => {
  hostSupportsDelegation = false;
  try {
    const result = await call(Methods.NATIVE_SESSION_CATALOG, {});
    assert(result && typeof result === 'object');
    for (const row of Reflect.get(result, 'executionNodes')) {
      assert.match(row.unavailableReason, /Refresh the native host/);
      assert.ok(Object.values(homes).includes(row.homeDirectory));
    }
    assert.deepEqual(Reflect.get(result, 'contexts'), []);
  } finally {
    hostSupportsDelegation = true;
  }
});

test('an offline machine remains in the catalog with a reason and no guessed home', async () => {
  unregisterByWs(sockets.get('mini')!);
  const result = await call(Methods.NATIVE_SESSION_CATALOG, {});
  assert(result && typeof result === 'object');
  const row = Reflect.get(result, 'executionNodes').find(
    (item: { executionNodeId: string }) => item.executionNodeId === 'mini',
  );
  assert(row);
  assert.equal(row.homeDirectory, undefined);
  assert.match(row.unavailableReason, /unavailable|connected/i);
});

test(
  'an authenticated generation-one person uses the production gateway RPC across all three targets',
  { timeout: 180_000 },
  async (t) => {
    // Private loopback gateway and synthetic execution sockets; no production identity or node changes.
    await import('../runtime/mock-pty.test-support.js');
    const { createWebSocketServer } = await import('../server.js');
    const { GatewayClient } = await import('../../../../packages/cli/src/gateway-client.js');
    registerNode(
      'mini',
      1,
      sockets.get('mini')!,
      undefined,
      undefined,
      {
        ownerPrincipalId: farm.id,
        supportsEnsure: true,
        supportsWorkers: true,
        supportsProfiles: true,
        supportsObservations: true,
        supportsStandaloneDelegation: true,
      },
      { principalId: 'node-mini', valid: () => true },
    );
    for (const machine of machines)
      nativeObservations.acceptRemote(sockets.get(machine)!, receipts.get(machine)!, () => true);
    const credential = auth.writer.issueCredential(arthur.id, 'Disposable loopback proof');
    const grant = auth.writer.exchangePersonCredential(credential.secret, {
      deviceName: 'Standalone delegation proof',
      deviceKind: 'cli',
    });
    const server = createServer();
    const wss = createWebSocketServer(server, auth);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${address.port}/ws`,
      credential: { token: grant.accessToken },
      timeout: 10_000,
    });
    try {
      const catalog = await client.call<{
        executionNodes: Array<{ executionNodeId: string; homeDirectory?: string }>;
      }>(Methods.NATIVE_SESSION_CATALOG, {});
      for (const machine of machines) {
        assert.equal(
          catalog.executionNodes.find((row) => row.executionNodeId === machine)?.homeDirectory,
          homes[machine],
        );
        const created = await client.call<{ session: NativeSessionInfo }>(
          Methods.NATIVE_SESSION_CREATE,
          { executionNodeId: machine, cwd: `${homes[machine]}/custom`, runner: 'codex' },
        );
        assert.equal(created.session.ownerPrincipalId, owners[machine]);
        assert.equal(created.session.requestedByPrincipalId, 'arthur');
        assert.equal(created.session.requestedByPrincipalGeneration, 1);
        await client.call(Methods.NATIVE_SESSION_SEND, {
          executionNodeId: machine,
          sessionId: created.session.id,
          commandId: `loopback-${machine}`,
          text: 'Protocol proof',
        });
        const read = await client.call<{ session: NativeSessionInfo }>(
          Methods.NATIVE_SESSION_READ,
          { executionNodeId: machine, sessionId: created.session.id },
        );
        assert.equal(read.session.ownerPrincipalId, owners[machine]);
        await client.call(Methods.NATIVE_SESSION_CLOSE, {
          executionNodeId: machine,
          sessionId: created.session.id,
        });
      }
      if (process.env.FARMSLOT_NATIVE_LAUNCH_BROWSER_PROOF === '1') {
        await writeFile(
          path.join(root, 'pool/offline-proof.json'),
          JSON.stringify({
            machine: 'offline-proof',
            host: 'offline-proof.invalid',
            ssh_user: 'fixture',
            os: 'macos',
            project: 'fixture',
            slots: [],
          }),
        );
        const { createServer: createVite } = await import('vite');
        const { fileURLToPath } = await import('node:url');
        const { CdpWebPage } =
          await import('../../../../packages/recipe-runner/src/runtime/cdp.js');
        const repo = fileURLToPath(new URL('../../../../', import.meta.url));
        const vite = await createVite({
          configFile: path.join(repo, 'apps/command-center/ui/vite.config.ts'),
          envDir: path.join(root, 'empty-env'),
          cacheDir: path.join(root, 'vite-cache'),
          logLevel: 'error',
          server: {
            host: '127.0.0.1',
            port: 0,
            strictPort: false,
            proxy: {
              '/ws': { target: `http://127.0.0.1:${address.port}`, ws: true },
              '/api': { target: `http://127.0.0.1:${address.port}` },
            },
          },
        });
        const cdpUrl = 'http://127.0.0.1:19224';
        let ownedTabId: string | undefined;
        t.after(async () => {
          try {
            if (ownedTabId) await fetch(`${cdpUrl}/json/close/${ownedTabId}`);
          } finally {
            await vite.close();
          }
        });
        await vite.listen();
        const uiAddress = vite.httpServer?.address();
        assert(uiAddress && typeof uiAddress !== 'string');
        const url = `http://127.0.0.1:${uiAddress.port}/#native`;
        const rawTab: unknown = await (
          await fetch(`${cdpUrl}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
        ).json();
        assert(
          rawTab &&
            typeof rawTab === 'object' &&
            'id' in rawTab &&
            typeof rawTab.id === 'string' &&
            'type' in rawTab &&
            typeof rawTab.type === 'string' &&
            'webSocketDebuggerUrl' in rawTab &&
            typeof rawTab.webSocketDebuggerUrl === 'string',
        );
        const tab = {
          id: rawTab.id,
          type: rawTab.type,
          webSocketDebuggerUrl: rawTab.webSocketDebuggerUrl,
        };
        ownedTabId = tab.id;
        const page = await CdpWebPage.connectToTarget(tab);
        try {
          await page.session.call('Page.bringToFront');
          await page.waitForSelector('.auth-input', { timeoutMs: 30_000 });
          await page.click('.auth-input');
          // The disposable fixture secret stays in memory and is typed through the actual form.
          // Never read browser storage or print credential-bearing DOM values.
          await page.session.call('Input.insertText', { text: credential.secret });
          await page.click('.auth-submit');
          await page.waitForSelector('native-session-view', { timeoutMs: 30_000 });
          // Fresh fixture origins show the release dialog; dismiss it through the real control.
          const releaseDialog = await page.evaluate<boolean>(
            `(() => [...document.querySelectorAll('whats-new-modal')].some((dialog) => dialog.open))()`,
          );
          if (releaseDialog) await page.clickText('Got it');
          await page.click('[data-testid="native-new"]');
          await page.waitForSelector('[data-testid="native-context"]', { timeoutMs: 10_000 });
          await page.waitForExpression(
            `(() => { const rows=document.querySelector('native-session-view')?.shadowRoot?.querySelectorAll('[data-testid=native-target-unavailable]'); return [...(rows??[])].some(row=>row.textContent.includes('offline-proof')&&row.textContent.includes('Target has no configured native owner')); })()`,
            { timeoutMs: 10_000 },
          );
          await page.click('[data-testid="review-dispatch-runner-codex"]');
          await page.waitForExpression(
            `(() => { const v=document.querySelector('native-session-view'); const s=v?.shadowRoot?.querySelector('[data-testid=native-context]'); return Boolean(s&&!s.disabled&&s.getBoundingClientRect().width>0); })()`,
            { timeoutMs: 10_000 },
          );
          const debugDirectory = process.env.FARMSLOT_NATIVE_LAUNCH_PROOF_DIR;
          if (debugDirectory) {
            assert(path.resolve(debugDirectory).startsWith('/tmp/cx-native-launch-'));
            await mkdir(debugDirectory, { recursive: true });
            const before = await page.evaluate(
              `(() => { const v=document.querySelector('native-session-view'); const s=v.shadowRoot.querySelector('[data-testid=native-context]'); const r=s.getBoundingClientRect(); return {node:v.executionNodeId,cwd:v.cwd,connected:v.connected,busy:v.busy,error:v.error,catalogError:v.catalogError,inventoryError:v.inventoryError,selected:s.value,disabled:s.disabled,rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight}}; })()`,
            );
            await writeFile(
              path.join(debugDirectory, 'before-custom.json'),
              JSON.stringify(before, null, 2),
            );
            const image = await page.session.call<{ data: string }>('Page.captureScreenshot', {
              format: 'png',
            });
            await writeFile(
              path.join(debugDirectory, 'before-custom.png'),
              Buffer.from(image.data, 'base64'),
            );
          }
          // Keyboard navigation avoids the OS-native popup while exercising the select's real change handler.
          await page.evaluate(
            `document.querySelector('native-session-view').shadowRoot.querySelector('[data-testid=native-context]').focus()`,
          );
          await page.session.call('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'o',
            code: 'KeyO',
            windowsVirtualKeyCode: 79,
            text: 'o',
            unmodifiedText: 'o',
          });
          await page.session.call('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'o',
            code: 'KeyO',
            windowsVirtualKeyCode: 79,
          });
          await page.keyPress('Tab');
          if (debugDirectory) {
            const selection = await page.evaluate(
              `(() => { const v=document.querySelector('native-session-view'); return {selected:v.shadowRoot.querySelector('[data-testid=native-context]').value,custom:v.customCwd,node:v.executionNodeId,cwd:v.cwd}; })()`,
            );
            await writeFile(
              path.join(debugDirectory, 'after-custom.json'),
              JSON.stringify(selection, null, 2),
            );
          }
          await page.waitForSelector('[data-testid="native-cwd"]', { timeoutMs: 10_000 });
          const initial = await page.evaluate<{ home: string; node: string }>(
            `(() => { const v=document.querySelector('native-session-view'); return {home:v.shadowRoot.querySelector('[data-testid=native-cwd]').value,node:v.executionNodeId}; })()`,
          );
          assert.deepEqual(initial, { home: homes.macwork, node: 'macwork' });
          const custom = `${homes.macwork}/ui-custom`;
          await page.setInput('[data-testid="native-cwd"]', custom);
          await page.waitForExpression(
            `(() => { const v=document.querySelector('native-session-view'); const b=v?.shadowRoot?.querySelector('[data-testid=native-create]'); return Boolean(b&&!b.disabled); })()`,
            { timeoutMs: 15_000 },
          );
          await page.click('[data-testid="native-create"]');
          await page.waitForExpression(
            `(() => { const v=document.querySelector('native-session-view'); return v?.session?.cwd===${JSON.stringify(custom)}; })()`,
            { timeoutMs: 15_000 },
          );
          const current = await page.evaluate<{
            id: string;
            node: string;
            owner: string;
            requester: string;
            generation: number;
            cwd: string;
          }>(
            `(() => { const s=document.querySelector('native-session-view').session; return {id:s.id,node:s.executionNodeId,owner:s.ownerPrincipalId,requester:s.requestedByPrincipalId,generation:s.requestedByPrincipalGeneration,cwd:s.cwd}; })()`,
          );
          assert.deepEqual(current, {
            id: 'macwork-session',
            node: 'macwork',
            owner: owners.macwork,
            requester: 'arthur',
            generation: 1,
            cwd: custom,
          });
          const output = process.env.FARMSLOT_NATIVE_LAUNCH_PROOF_DIR;
          if (output) {
            assert(path.resolve(output).startsWith('/tmp/cx-native-launch-'));
            await mkdir(output, { recursive: true });
            const screenshot = await page.session.call<{ data: string }>('Page.captureScreenshot', {
              format: 'png',
            });
            await writeFile(
              path.join(output, 'conversation.png'),
              Buffer.from(screenshot.data, 'base64'),
            );
            await writeFile(
              path.join(output, 'proof.json'),
              JSON.stringify(
                {
                  pass: true,
                  initial,
                  session: current,
                  isolation: 'private gateway, fixture identity and synthetic execution nodes',
                },
                null,
                2,
              ),
            );
          }
          await client.call(Methods.NATIVE_SESSION_CLOSE, {
            executionNodeId: 'macwork',
            sessionId: current.id,
          });
        } catch (error) {
          const output = process.env.FARMSLOT_NATIVE_LAUNCH_PROOF_DIR;
          if (output && path.resolve(output).startsWith('/tmp/cx-native-launch-')) {
            await mkdir(output, { recursive: true });
            const screen = await page.session.call<{ data: string }>('Page.captureScreenshot', {
              format: 'png',
            });
            await writeFile(path.join(output, 'failure.png'), Buffer.from(screen.data, 'base64'));
            const diagnostic = await page.evaluate(
              `(() => { const v=document.querySelector('native-session-view'); return {body:document.body.innerText,native:v?{error:v.error,catalogError:v.catalogError,inventoryError:v.inventoryError,connected:v.connected,creating:v.creating,catalog:v.catalog}:null}; })()`,
            );
            await writeFile(path.join(output, 'failure.json'), JSON.stringify(diagnostic, null, 2));
          }
          throw error;
        } finally {
          page.session.close();
        }
      }
    } finally {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      nativeObservations.dispose();
    }
  },
);

test('admin delegation never adopts a replacement generation as execution owner', async () => {
  const node = auth.writer.createPrincipal(
    {
      type: 'node',
      displayName: 'Invalid owner',
      machine: 'replaced-owner-node',
      nativeOwnerPrincipalId: arthur.id,
    },
    [],
    'replaced-owner-node',
  );
  auth.writer.issueCredential(node.id, 'Fixture invalid owner');
  const socket = {
    readyState: WebSocket.OPEN,
    send(_raw: string): void {
      assert.fail('A replaced execution owner must not receive commands');
    },
  } as WebSocket;
  registerNode(
    'replaced-owner-node',
    1,
    socket,
    undefined,
    undefined,
    { ownerPrincipalId: arthur.id, supportsStandaloneDelegation: true },
    { principalId: node.id, valid: () => true },
  );
  try {
    await assert.rejects(
      call(Methods.NATIVE_SESSION_CREATE, {
        executionNodeId: 'replaced-owner-node',
        runner: 'codex',
        cwd: '/tmp',
      }),
      /replacement identity/,
    );
  } finally {
    unregisterByWs(socket);
  }
});

test('restoring macwork to automation needs no new human identity or ownership transfer', async () => {
  const old = auth.store
    .snapshot()
    .credentials.filter((credential) => credential.principalId === 'node-macwork');
  for (const credential of old) auth.writer.revokeCredential(credential.id);
  auth.writer.retirePrincipals(['node-macwork']);
  const node = auth.writer.createPrincipal(
    {
      type: 'node',
      displayName: 'Automation macwork',
      machine: 'macwork',
      nativeOwnerPrincipalId: farm.id,
    },
    [],
    'node-macwork-farm',
  );
  auth.writer.issueCredential(node.id, 'Fixture restored node');
  owners.macwork = farm.id;
  registerNode(
    'macwork',
    1,
    sockets.get('macwork')!,
    undefined,
    undefined,
    {
      ownerPrincipalId: farm.id,
      supportsEnsure: true,
      supportsWorkers: true,
      supportsProfiles: true,
      supportsObservations: true,
      supportsStandaloneDelegation: true,
    },
    { principalId: node.id, valid: () => true },
  );
  const result = await call(Methods.NATIVE_SESSION_CREATE, {
    executionNodeId: 'macwork',
    runner: 'codex',
    cwd: homes.macwork,
  });
  assert(result && typeof result === 'object');
  const info: unknown = Reflect.get(result, 'session');
  assert(info && typeof info === 'object');
  assert.equal(Reflect.get(info, 'ownerPrincipalId'), farm.id);
  assert.equal(Reflect.get(info, 'requestedByPrincipalId'), 'arthur');
  assert.equal(Reflect.get(info, 'requestedByPrincipalGeneration'), 1);
  assert.equal(arthur.generation, 1);
});
