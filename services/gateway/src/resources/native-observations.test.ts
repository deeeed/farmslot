import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { WebSocket } from 'ws';

import type {
  NativeProfileStatusResult,
  NativeSessionInfo,
  Principal,
  Run,
} from '@farmslot/protocol';
import { type ResourceKey, resourceKeyId } from '@farmslot/protocol/client-cache';

import { registerNode, unregisterByWs } from '../fleet/machine-registry.js';
import { createRun, deleteRun, updateRun } from '../runs/store.js';
import { runWithSessionOriginator } from '../security/work-originator.js';

import {
  authorizeNativeObservation,
  GatewayNativeObservations,
  type NativeInterest,
} from './native-observations.js';

const a: Principal = {
  id: 'producer-owner-a',
  subject: { type: 'person', displayName: 'A' },
  roles: [{ role: 'admin', scope: { kind: 'global' } }],
};
const b: Principal = { ...a, id: 'producer-owner-b' };
const admin: Principal = { ...a, id: 'producer-supervisor' };

test('private reader keys reject A/B and node subjects before source access', async () => {
  const interest: NativeInterest = {
    key: { family: 'native-session', scope: 'owner', ownerId: a.id },
    method: 'native.session.list',
    params: {},
  };
  await assert.rejects(authorizeNativeObservation(b, interest), { code: 'AUTH_FORBIDDEN' });
  await assert.rejects(
    authorizeNativeObservation(
      { ...a, subject: { type: 'node', machine: 'n', displayName: 'N' } },
      interest,
    ),
    { code: 'AUTH_FORBIDDEN' },
  );
  // Admin does not adopt A's key or gain A's collection by method-level authority.
  await assert.rejects(authorizeNativeObservation(admin, interest), { code: 'AUTH_FORBIDDEN' });
});

test('registered exact socket owns source admission, replacement revokes old socket and receipts', () => {
  const machine = `producer-${randomUUID()}`;
  const old = { readyState: WebSocket.OPEN } as WebSocket;
  const replacement = { readyState: WebSocket.OPEN } as WebSocket;
  const source = new GatewayNativeObservations(() => undefined);
  const receipt = {
    version: 1 as const,
    nodeId: machine,
    ownerId: a.id,
    incarnation: 'first',
    revision: 0,
    ready: true,
  };
  const declare = { ownerPrincipalId: a.id, supportsObservations: true };
  const authority = { principalId: 'node-source', valid: () => true };
  registerNode(machine, 1, old, undefined, undefined, declare, authority);
  try {
    assert.throws(() => source.acceptRemote(replacement, receipt, () => true), {
      code: 'AUTH_FORBIDDEN',
    });
    source.acceptRemote(old, receipt, () => true);
    assert.deepEqual(
      source.unwrapRemote(old, machine, { nativeSource: receipt, value: ['saved'] }),
      ['saved'],
    );
    source.acceptRemote(
      old,
      { ...receipt, revision: 1, ready: false, error: 'SOURCE_UNAVAILABLE' },
      () => true,
    );
    assert.throws(() => source.unwrapRemote(old, machine, { nativeSource: receipt, value: [] }), {
      code: 'NATIVE_SOURCE_UNAVAILABLE',
    });
    registerNode(machine, 2, replacement, undefined, undefined, declare, authority);
    assert.throws(() => source.acceptRemote(old, receipt, () => true), { code: 'AUTH_FORBIDDEN' });
    source.acceptRemote(replacement, { ...receipt, incarnation: 'replacement' }, () => true);
    assert.throws(() => source.unwrapRemote(old, machine, { nativeSource: receipt, value: [] }), {
      code: 'NATIVE_SOURCE_UNAVAILABLE',
    });
    source.disconnectRemote(old); // Late old close cannot remove replacement.
    assert.equal(
      source.unwrapRemote(replacement, machine, {
        nativeSource: { ...receipt, incarnation: 'replacement' },
        value: 'current',
      }),
      'current',
    );
    source.disconnectRemote(replacement);
    assert.throws(
      () => source.unwrapRemote(replacement, machine, { nativeSource: receipt, value: [] }),
      { code: 'NATIVE_SOURCE_UNAVAILABLE' },
    );
  } finally {
    source.dispose();
    unregisterByWs(old);
    unregisterByWs(replacement);
  }
});

test('admin history aliases require exact stored run/context/lease and current supervision', async (t) => {
  const previous = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = a.id;
  let run: Run | undefined;
  t.after(async () => {
    if (run) {
      const saved = (await import('../runs/store.js')).getRun(run.id);
      updateRun(run.id, {
        status: 'done',
        completedAt: new Date().toISOString(),
        agentContexts: saved?.agentContexts?.map((context) => ({
          ...context,
          ...(context.nativeSession
            ? { nativeSession: { ...context.nativeSession, releasedAt: new Date().toISOString() } }
            : {}),
        })),
      });
      await deleteRun(run.id);
    }
    if (previous === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previous;
  });
  run = runWithSessionOriginator(a, () =>
    createRun({
      flowType: 'dev',
      project: 'native-producer-test',
      ticketOrPr: randomUUID(),
      transport: 'native',
    }),
  );
  const binding = {
    sessionId: randomUUID(),
    generation: randomUUID(),
    leaseId: randomUUID(),
    commandId: randomUUID(),
    ownerPrincipalId: a.id,
    executionNodeId: 'local',
  };
  const context = {
    id: 'dev',
    role: 'dev' as const,
    label: 'Dev',
    status: 'idle' as const,
    slotId: 'native-source-fixture',
    runId: run.id,
    nativeSession: binding,
  };
  updateRun(run.id, { agentContexts: [context] });
  const interest: NativeInterest = {
    key: {
      family: 'native-session',
      nodeId: 'local',
      ownerId: admin.id,
      sessionId: binding.sessionId,
      workerId: run.id,
    },
    method: 'native.session.read',
    params: {
      sessionId: binding.sessionId,
      worker: {
        runId: run.id,
        contextId: context.id,
        generation: binding.generation,
        leaseId: binding.leaseId,
      },
    },
  };
  assert.deepEqual(await authorizeNativeObservation(admin, interest), {
    ownerId: a.id,
    nodes: ['local'],
  });
  await assert.rejects(authorizeNativeObservation({ ...admin, roles: [] }, interest), {
    code: 'AUTH_FORBIDDEN',
  });
  await assert.rejects(
    authorizeNativeObservation(b, {
      ...interest,
      key: { ...interest.key, ownerId: b.id },
      params: {
        ...interest.params,
        worker: { ...(interest.params.worker as object), leaseId: 'reused' },
      },
    }),
    { code: 'NOT_FOUND' },
  );
  // This setup record never launched a host. Record its release before slot reuse,
  // preserving the same store ownership rule used by real confirmed transfer.
  updateRun(run.id, {
    agentContexts: [
      {
        ...context,
        nativeSession: {
          ...binding,
          releasedAt: new Date().toISOString(),
        },
      },
    ],
  });
  updateRun(run.id, {
    agentContexts: [{ ...context, nativeSession: { ...binding, leaseId: 'new-lease' } }],
  });
  await assert.rejects(authorizeNativeObservation(admin, interest), { code: 'NOT_FOUND' });
});

test('commands and ended connections cannot use source admission or replay', async () => {
  const source = new GatewayNativeObservations(() => undefined);
  const connection = {};
  source.attachClient(connection, () => a);
  let calls = 0;
  const interest: NativeInterest = {
    key: { family: 'native-session', scope: 'owner', ownerId: a.id },
    method: 'native.session.send',
    params: {},
  };
  await assert.rejects(
    source.read(
      connection,
      [interest],
      async () => {
        calls++;
      },
      () => ({}),
    ),
    { code: 'INVALID_PARAMS' },
  );
  source.detachClient(connection);
  await assert.rejects(
    source.read(
      connection,
      [],
      async () => {
        calls++;
      },
      () => ({}),
    ),
    { code: 'AUTH_FORBIDDEN' },
  );
  assert.equal(calls, 0);
  source.dispose();
});

test('wire page keys keep real reader and pin while preserving cursor params unchanged', async () => {
  const { nativeReadInterests } = await import('./native-observations.js');
  const params = {
    sessionId: 's',
    after: 71,
    limit: 35,
    worker: {
      runId: 'run',
      contextId: 'dev',
      leaseId: 'lease',
      generation: 'generation',
    },
  };
  const interests = nativeReadInterests('native.session.read', params, admin.id)!;
  assert.equal(interests[0].params, params);
  assert.deepEqual(interests[0].key, {
    family: 'native-session',
    nodeId: 'local',
    ownerId: admin.id,
    sessionId: 's',
    workerId: 'run',
  });
  assert.deepEqual(nativeReadInterests('native.session.list', {}, a.id)?.[0].key, {
    family: 'native-session',
    scope: 'owner',
    ownerId: a.id,
  });
  assert.equal(nativeReadInterests('native.session.send', params, a.id), undefined);
  assert.throws(
    () => nativeReadInterests('native.session.read', { ...params, ownerId: b.id }, a.id),
    { code: 'INVALID_PARAMS' },
  );
});

test('source revision or replacement during a held real-route read refuses the late page', async () => {
  const machine = `producer-held-${randomUUID()}`;
  const socket = { readyState: WebSocket.OPEN } as WebSocket;
  const source = new GatewayNativeObservations(() => undefined);
  const connection = {};
  const receipt = {
    version: 1 as const,
    nodeId: machine,
    ownerId: a.id,
    incarnation: 'source',
    revision: 0,
    ready: true,
  };
  registerNode(
    machine,
    1,
    socket,
    undefined,
    undefined,
    { ownerPrincipalId: a.id, ...{ supportsObservations: true } },
    { principalId: 'held-node', valid: () => true },
  );
  source.attachClient(connection, () => a);
  source.acceptRemote(socket, receipt, () => true);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const pending = source.read(
      connection,
      [
        {
          key: { family: 'native-session', nodeId: machine, ownerId: a.id },
          method: 'native.session.list',
          params: { executionNodeId: machine },
        },
      ],
      async () => {
        await held;
        return { sessions: [] };
      },
      () => ({ epoch: 'test' }),
    );
    // Enter after the pre-read await chain, rather than assuming a request callback arms a source.
    await new Promise<void>((resolve) => setImmediate(resolve));
    source.acceptRemote(socket, { ...receipt, revision: 1 }, () => true);
    release();
    await assert.rejects(pending, { code: 'NATIVE_SOURCE_UNAVAILABLE' });
    assert.equal(
      await source.canReadKey(connection, {
        family: 'native-session',
        nodeId: machine,
        ownerId: a.id,
      }),
      true,
      'The rejected old page stays stale, but its authorized collection must receive recovery',
    );
  } finally {
    release?.();
    source.dispose();
    unregisterByWs(socket);
  }
});

test('authorized collection recovery notifies an observer whose initial source read failed', async () => {
  const machine = `producer-recovery-${randomUUID()}`;
  const socket = { readyState: WebSocket.OPEN } as WebSocket;
  const published: import('./native-observations.js').NativeObservationKey[] = [];
  const source = new GatewayNativeObservations((key) => published.push(key));
  const connection = {};
  const key = { family: 'native-session' as const, nodeId: machine, ownerId: a.id };
  const receipt = {
    version: 1 as const,
    nodeId: machine,
    ownerId: a.id,
    incarnation: 'recovering',
    revision: 0,
    ready: false,
    error: 'SOURCE_UNAVAILABLE' as const,
  };
  registerNode(
    machine,
    1,
    socket,
    undefined,
    undefined,
    { ownerPrincipalId: a.id, supportsObservations: true },
    { principalId: 'recovery-node', valid: () => true },
  );
  source.attachClient(connection, () => a);
  source.acceptRemote(socket, receipt, () => true);
  let reads = 0;
  try {
    await assert.rejects(
      source.read(
        connection,
        [{ key, method: 'native.session.list', params: { executionNodeId: machine } }],
        async () => {
          reads++;
          return { sessions: [] };
        },
        () => ({}),
      ),
      { code: 'NATIVE_SOURCE_UNAVAILABLE' },
    );
    assert.equal(reads, 0);
    source.acceptRemote(
      socket,
      { ...receipt, revision: 1, ready: true, error: undefined },
      () => true,
    );
    assert.deepEqual(published, [key]);
    assert.equal(await source.canReadKey(connection, key), true);
  } finally {
    source.dispose();
    unregisterByWs(socket);
  }
});

// Source-only regression additions. Parent executes these serially after integration.
async function partialFixture(
  t: import('node:test').TestContext,
  publish?: (key: NativeInterest['key']) => void,
) {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { CredentialStoreRuntime } = await import('../security/credential-store.js');
  const { CredentialStoreWriter } = await import('../security/credential-store-writer.js');
  const home = mkdtempSync(join(tmpdir(), 'native-partial-'));
  const previousHome = process.env.FARMSLOT_HOME;
  const previousOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_HOME = home;
  const runtime = new CredentialStoreRuntime({ FARMSLOT_HOME: home });
  const writer = new CredentialStoreWriter(runtime);
  const owner = writer.createPrincipal({ type: 'person', displayName: 'Partial owner' }, []);
  const other = writer.createPrincipal({ type: 'person', displayName: 'Other owner' }, []);
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;
  const healthy = `healthy-${randomUUID()}`;
  const offline = `offline-${randomUUID()}`;
  const old = `old-${randomUUID()}`;
  const issued = new Map<string, string>();
  for (const machine of [healthy, offline, old]) {
    const node = writer.createPrincipal(
      { type: 'node', displayName: machine, machine, nativeOwnerPrincipalId: owner.id },
      [],
    );
    writer.issueCredential(node.id, 'node');
    issued.set(machine, node.id);
  }
  const socket = { readyState: WebSocket.OPEN } as WebSocket;
  const oldSocket = { readyState: WebSocket.OPEN } as WebSocket;
  registerNode(
    healthy,
    1,
    socket,
    undefined,
    undefined,
    { ownerPrincipalId: owner.id, supportsObservations: true },
    { principalId: issued.get(healthy)!, valid: () => true },
  );
  registerNode(
    old,
    1,
    oldSocket,
    undefined,
    undefined,
    { ownerPrincipalId: owner.id },
    { principalId: issued.get(old)!, valid: () => true },
  );
  const published: import('./native-observations.js').NativeObservationKey[] = [];
  const source = new GatewayNativeObservations((key) => {
    published.push(key);
    publish?.(key);
  });
  const connection = {};
  source.attachClient(connection, () => owner);
  const receipt = {
    version: 1 as const,
    nodeId: healthy,
    ownerId: owner.id,
    incarnation: 'healthy-source',
    revision: 0,
    ready: true,
  };
  source.acceptRemote(socket, receipt, () => true);
  const interest: NativeInterest = {
    key: { family: 'native-session', scope: 'owner', ownerId: owner.id },
    method: 'native.session.list',
    params: {},
  };
  t.after(() => {
    source.dispose();
    unregisterByWs(socket);
    unregisterByWs(oldSocket);
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
    if (previousOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previousOwner;
    rmSync(home, { recursive: true, force: true });
  });
  return {
    home,
    source,
    connection,
    owner,
    other,
    healthy,
    offline,
    old,
    socket,
    receipt,
    interest,
    published,
    writer,
    issued,
  };
}

test('cross-node inventory admits healthy bytes and explicitly accounts for offline, old and unarmed local hosts', async (t) => {
  const f = await partialFixture(t);
  const { admitNativeCollectionNode } = await import('./native-observations.js');
  const unavailable = [f.offline, f.old, 'local'].map((executionNodeId) => ({
    executionNodeId,
    message: 'Source unavailable',
  }));
  const result = await f.source.read(
    f.connection,
    [f.interest],
    async () => {
      admitNativeCollectionNode(f.healthy);
      for (const id of [f.offline, f.old, 'local'])
        assert.throws(() => admitNativeCollectionNode(id), { code: 'NATIVE_SOURCE_UNAVAILABLE' });
      return { sessions: [], unavailableExecutionNodes: unavailable };
    },
    () => ({ marker: 1 }),
  );
  assert.deepEqual(result.payload.unavailableExecutionNodes, unavailable);
  await assert.rejects(
    f.source.read(
      f.connection,
      [f.interest],
      async () => ({ sessions: [], unavailableExecutionNodes: [] }),
      () => ({}),
    ),
    { code: 'NATIVE_SOURCE_UNAVAILABLE' },
  );
  await assert.rejects(
    f.source.read(
      f.connection,
      [{ ...f.interest, key: { ...f.interest.key, ownerId: f.other.id } }],
      async () => assert.fail('foreign read'),
      () => ({}),
    ),
    { code: 'AUTH_FORBIDDEN' },
  );
});

test('partial list projection refuses failed/foreign bytes and accepts admitted local plus remote sessions', async () => {
  const { validatePartialNativeList } = await import('./native-observations.js');
  const sessions = ['local', 'remote'].map((executionNodeId) => ({
    executionNodeId,
    ownerPrincipalId: a.id,
    id: executionNodeId,
  }));
  const admitted = new Set(['local', 'remote']);
  const skipped = new Set(['offline', 'old']);
  const unavailableExecutionNodes = [...skipped].map((executionNodeId) => ({ executionNodeId }));
  validatePartialNativeList({ sessions, unavailableExecutionNodes }, admitted, skipped, a.id);
  for (const extra of [
    { executionNodeId: 'old', ownerPrincipalId: a.id },
    { executionNodeId: 'remote', ownerPrincipalId: b.id },
  ]) {
    assert.throws(
      () =>
        validatePartialNativeList(
          { sessions: [...sessions, extra], unavailableExecutionNodes },
          admitted,
          skipped,
          a.id,
        ),
      { code: 'NATIVE_SOURCE_UNAVAILABLE' },
    );
  }
});

test('catalog admission uses preferences and pool metadata without booting a journal host', async (t) => {
  const f = await partialFixture(t);
  const interest = { ...f.interest, method: 'native.session.catalog' };
  const { nativeCatalogChanges } = await import('./native-catalog-changes.js');
  let routes = 0;
  const read = () =>
    f.source.read(
      f.connection,
      [interest],
      async () => {
        routes++;
        return { contexts: [{ cwd: '/fixture', executionNodeId: 'local' }], runners: [] };
      },
      () => ({}),
    );
  assert.equal((await read()).payload.contexts.length, 1);
  assert.equal(routes, 1);
  await assert.rejects(
    f.source.read(
      f.connection,
      [interest],
      async () => {
        nativeCatalogChanges.catalogChanged();
        return { contexts: [], runners: [] };
      },
      () => ({}),
    ),
    { code: 'NATIVE_SOURCE_UNAVAILABLE' },
  );
  assert.equal((await read()).payload.contexts.length, 1);
});

test('durable preference writes reach the admitted gateway catalog key without foreign invalidations', async (t) => {
  const f = await partialFixture(t);
  const { KNOWN_RUNNERS } = await import('../runners/registry.js');
  const { readVisibleModelFile, writeVisibleModelFile } =
    await import('../runners/visible-models.js');
  const { resourceRevisions } = await import('./revisions.js');
  const { resourceKeyId } = await import('@farmslot/protocol/client-cache');
  const interest = { ...f.interest, method: 'native.session.catalog' };
  const source = new GatewayNativeObservations((key) => resourceRevisions.advance(key));
  source.attachClient(f.connection, () => f.owner);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    source.dispose();
    resourceRevisions.dispose();
    resourceRevisions.setPublisher(() => {});
    t.mock.timers.reset();
  });
  await source.read(
    f.connection,
    [interest],
    async () => ({ contexts: [], runners: [] }),
    () => ({}),
  );
  resourceRevisions.dispose();
  const keys: string[] = [];
  resourceRevisions.setPublisher((packet) =>
    keys.push(...packet.changes.map((change) => resourceKeyId(change.key))),
  );
  const runner = Object.values(KNOWN_RUNNERS).find(
    (definition) => definition.nativeTransport && definition.nativeChoices,
  )!.id;
  const preference = { version: 1 as const, byRunner: { [runner]: ['private-model'] } };
  runWithSessionOriginator(f.owner, () => writeVisibleModelFile(preference));
  assert.deepEqual(
    runWithSessionOriginator(f.owner, () => readVisibleModelFile()).byRunner,
    preference.byRunner,
  );
  await Promise.resolve();
  t.mock.timers.tick(201);
  assert.deepEqual(keys, [resourceKeyId(interest.key)]);
  keys.length = 0;
  runWithSessionOriginator(f.other, () => writeVisibleModelFile(preference));
  await Promise.resolve();
  t.mock.timers.tick(201);
  assert.deepEqual(keys, []);
});

test('partial source recovery invalidates private collection and recovery during held page rejects it', async (t) => {
  const f = await partialFixture(t);
  f.source.acceptRemote(
    f.socket,
    { ...f.receipt, revision: 1, ready: false, error: 'SOURCE_UNAVAILABLE' },
    () => true,
  );
  const unavailableExecutionNodes = [f.healthy, f.offline, f.old, 'local'].map(
    (executionNodeId) => ({ executionNodeId, message: 'Unavailable' }),
  );
  await f.source.read(
    f.connection,
    [f.interest],
    async () => ({ sessions: [], unavailableExecutionNodes }),
    () => ({}),
  );
  f.published.length = 0;
  await assert.rejects(
    f.source.read(
      f.connection,
      [f.interest],
      async () => {
        f.source.acceptRemote(f.socket, { ...f.receipt, revision: 2 }, () => true);
        return { sessions: [], unavailableExecutionNodes };
      },
      () => ({}),
    ),
    { code: 'NATIVE_SOURCE_UNAVAILABLE' },
  );
  assert.deepEqual(f.published, [f.interest.key]);
  assert.equal(await f.source.canReadKey(f.connection, f.interest.key), true);
  assert.equal(
    await f.source.canReadKey(f.connection, { ...f.interest.key, ownerId: f.other.id }),
    false,
  );
});

test('connection or issued assignment replacement during collection route rejects held metadata', async (t) => {
  const f = await partialFixture(t);
  const replacement = { readyState: WebSocket.OPEN } as WebSocket;
  t.after(() => unregisterByWs(replacement));
  const interest = { ...f.interest, method: 'native.session.catalog' };
  await assert.rejects(
    f.source.read(
      f.connection,
      [interest],
      async () => {
        registerNode(
          f.healthy,
          2,
          replacement,
          undefined,
          undefined,
          { ownerPrincipalId: f.owner.id, supportsObservations: true },
          { principalId: f.issued.get(f.healthy)!, valid: () => true },
        );
        return { contexts: [], runners: [] };
      },
      () => ({}),
    ),
    { code: 'NATIVE_SOURCE_UNAVAILABLE' },
  );
  await assert.rejects(
    f.source.read(
      f.connection,
      [interest],
      async () => {
        f.writer.issueCredential(f.issued.get(f.offline)!, 'replacement credential');
        return { contexts: [], runners: [] };
      },
      () => ({}),
    ),
    { code: 'NATIVE_SOURCE_UNAVAILABLE' },
  );
});

test('targeted old and failed hosts refuse before route instead of using partial inventory', async (t) => {
  const f = await partialFixture(t);
  for (const executionNodeId of [f.old, 'local']) {
    const interest: NativeInterest = {
      key: {
        family: 'native-session',
        nodeId: executionNodeId,
        ownerId: f.owner.id,
        sessionId: 'saved',
      },
      method: 'native.session.read',
      params: { executionNodeId, sessionId: 'saved' },
    };
    await assert.rejects(
      f.source.read(
        f.connection,
        [interest],
        async () => assert.fail('must not sample'),
        () => ({}),
      ),
      { code: 'NATIVE_SOURCE_UNAVAILABLE' },
    );
  }
});

test('a previously ready source failing during a partial list rejects the entire old page', async (t) => {
  const f = await partialFixture(t);
  await assert.rejects(
    f.source.read(
      f.connection,
      [f.interest],
      async () => {
        f.source.acceptRemote(
          f.socket,
          { ...f.receipt, revision: 1, ready: false, error: 'SOURCE_UNAVAILABLE' },
          () => true,
        );
        return {
          sessions: [],
          unavailableExecutionNodes: [f.offline, f.old, 'local'].map((executionNodeId) => ({
            executionNodeId,
            message: 'Unavailable',
          })),
        };
      },
      () => ({}),
    ),
    { code: 'NATIVE_SOURCE_UNAVAILABLE' },
  );
});

test('removing an issued assignment during catalog read rejects its former contexts', async (t) => {
  const f = await partialFixture(t);
  const interest = { ...f.interest, method: 'native.session.catalog' };
  const survivor = f.writer.createPrincipal({ type: 'service', displayName: 'Fixture admin' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  f.writer.issueCredential(survivor.id, 'surviving fixture authority');
  const { loadCredentialStore } = await import('../security/credential-store.js');
  await assert.rejects(
    f.source.read(
      f.connection,
      [interest],
      async () => {
        const removed = f.issued.get(f.offline)!;
        for (const credential of loadCredentialStore().credentials.filter(
          (row) => row.principalId === removed,
        ))
          f.writer.revokeCredential(credential.id);
        f.writer.retirePrincipals([removed]);
        return { contexts: [], runners: [] };
      },
      () => ({}),
    ),
    { code: 'NATIVE_SOURCE_UNAVAILABLE' },
  );
});

test('profile interests use the authenticated owner and exact node for list/status and deny foreign admin aliases', async () => {
  const { nativeReadInterests } = await import('./native-observations.js');
  const source = new GatewayNativeObservations(() => assert.fail('No source was armed'));
  const readers = [a, b, admin];
  const connections = readers.map(() => ({}));
  try {
    readers.forEach((reader, index) => source.attachClient(connections[index], () => reader));
    for (const owner of [a, b]) {
      for (const method of ['native.profile.list', 'native.profile.status']) {
        const params = {
          executionNodeId: `profile-node-${owner.id}`,
          ...(method === 'native.profile.status' ? { profileId: 'private-profile' } : {}),
        };
        const interests = nativeReadInterests(method, params, owner.id)!;
        assert.equal(interests.length, 1);
        assert.equal(interests[0].params, params);
        assert.deepEqual(interests[0].key, {
          family: 'profiles',
          nodeId: params.executionNodeId,
          ownerId: owner.id,
        });
        for (const foreign of readers.filter((reader) => reader.id !== owner.id)) {
          await assert.rejects(authorizeNativeObservation(foreign, interests[0]), {
            code: 'AUTH_FORBIDDEN',
          });
          const index = readers.findIndex((reader) => reader.id === foreign.id);
          assert.equal(await source.canReadKey(connections[index], interests[0].key), false);
        }
        assert.throws(
          () => nativeReadInterests(method, { ...params, ownerId: owner.id }, admin.id),
          { code: 'INVALID_PARAMS' },
        );
        assert.throws(
          () => nativeReadInterests(method, { ...params, ownerGeneration: 0 }, owner.id),
          { code: 'INVALID_PARAMS' },
        );
      }
    }
    assert.equal(nativeReadInterests('native.profile.add', {}, a.id), undefined);
    assert.equal(nativeReadInterests('native.profile.remove', {}, a.id), undefined);
  } finally {
    source.dispose();
  }
});

/** Real journal/profile files and runtime source; only the account collector is a test seam. */
async function actualProducerFixture(t: import('node:test').TestContext) {
  const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { addNativeProfile, providerAccountsConfigPath } =
    await import('@farmslot/agent-runtime/native/account-profiles');
  const { NativeSessionClient } = await import('@farmslot/agent-runtime/native/client');
  const { NativeHostObservation } = await import('@farmslot/agent-runtime/native/observation');
  const { NativeSessionManager } = await import('@farmslot/agent-runtime/native/manager');
  const { resourceRevisions } = await import('./revisions.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await partialFixture(t, (key) => resourceRevisions.advance(key));
  const root = join(f.home, 'private-native-source');
  const sessions = join(root, 'sessions');
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  // recursive mkdir does not apply mode to existing ancestors; both are owned here.
  const { chmodSync } = await import('node:fs');
  chmodSync(root, 0o700);
  const info: NativeSessionInfo = {
    id: randomUUID(),
    nativeSessionId: 'saved-conversation',
    generation: 'saved-generation',
    hostPid: process.pid,
    runner: 'codex',
    ownerPrincipalId: f.owner.id,
    executionNodeId: f.healthy,
    accountContextId: 'saved-context',
    cwd: root,
    executable: '/bin/false',
    version: '1',
    mode: 'default',
    accountMode: 'native',
    workerManaged: false,
    state: 'idle',
    processStopped: true,
    capabilities: {
      modes: ['default'],
      streaming: true,
      tools: true,
      approvals: true,
      questions: true,
      interrupt: true,
      resume: true,
    },
  };
  const journal = join(sessions, `${info.id}.journal`);
  writeFileSync(
    journal,
    JSON.stringify({
      info,
      context: {},
      pending: [],
      commands: [
        {
          commandId: 'saved-queued',
          generation: info.generation,
          state: 'pending',
          queued: true,
          text: 'never submitted',
          submitted: false,
          accepted: false,
        },
      ],
    }) + '\n',
    { mode: 0o600 },
  );
  const profile = await addNativeProfile({ runner: 'codex', profileId: 'source-profile' }, f.home);
  let status: NativeProfileStatusResult = {
    profile,
    account: {
      runner: 'codex',
      installed: true,
      login: 'authenticated',
      mode: 'subscription',
      identityQuality: 'display-only',
      observedAt: '2026-10-24T00:00:00.000Z',
    },
    loginCommand: 'login',
  };
  let probes = 0;
  let delivering = true;
  const producer = new NativeHostObservation(
    new NativeSessionClient(root, f.healthy),
    f.owner.id,
    (receipt) => {
      if (delivering) f.source.acceptRemote(f.socket, receipt, () => true);
    },
    f.home,
    async () => {
      probes++;
      return [structuredClone(status)];
    },
  );
  t.after(() => {
    delivering = false;
    producer.stop();
    resourceRevisions.dispose();
    resourceRevisions.setPublisher(() => {});
    t.mock.timers.reset();
  });
  await producer.start();
  const history: NativeInterest[] = [
    {
      key: { family: 'native-session', nodeId: f.healthy, ownerId: f.owner.id },
      method: 'native.session.list',
      params: { executionNodeId: f.healthy },
    },
    {
      key: { family: 'native-session', nodeId: f.healthy, ownerId: f.owner.id, sessionId: info.id },
      method: 'native.session.read',
      params: { executionNodeId: f.healthy, sessionId: info.id },
      session: info,
    },
  ];
  const profiles: NativeInterest = {
    key: { family: 'profiles', nodeId: f.healthy, ownerId: f.owner.id },
    method: 'native.profile.status',
    params: { executionNodeId: f.healthy, profileId: profile.id },
  };
  // Admission setup reads actual bytes through both runtime and gateway fences.
  // It makes no claim about an RPC payload or platform rendering.
  for (const interest of [...history, profiles])
    await f.source.read(
      f.connection,
      [interest],
      async () => {
        const envelope = await producer.read(async () => readFileSync(journal, 'utf8'));
        return f.source.unwrapRemote(f.socket, f.healthy, envelope);
      },
      () => ({}),
    );
  resourceRevisions.dispose();
  const packets: ResourceKey[] = [];
  resourceRevisions.setPublisher((packet) =>
    packets.push(...packet.changes.map((change) => change.key)),
  );
  const publication = async (expected: ResourceKey[]) => {
    await Promise.resolve();
    t.mock.timers.tick(201);
    await Promise.resolve();
    assert.deepEqual(packets.map(resourceKeyId).sort(), expected.map(resourceKeyId).sort());
    packets.length = 0;
  };
  return {
    ...f,
    producer,
    info,
    history,
    profiles,
    publication,
    manager: () => new NativeSessionManager(sessions, f.healthy),
    journal: () => readFileSync(journal, 'utf8'),
    registration: () => readFileSync(providerAccountsConfigPath(f.home), 'utf8'),
    probes: () => probes,
    changeAccount(observedAt: string) {
      status = { ...status, account: { ...status.account, login: 'signed-out', observedAt } };
    },
    sampledAt: () => producer.profileStatus(profile.id).account.observedAt,
  };
}

test('actual native manager recovery and queued cancellation publish exact history keys after durable writes', async (t) => {
  const f = await actualProducerFixture(t);
  const before = f.journal();
  const manager = f.manager(); // Actual constructor persists crash recovery; it launches no process.
  assert.equal(manager.read(f.owner.id, f.info.id).session.state, 'failed');
  assert.notEqual(f.journal(), before);
  assert.match(f.journal(), /session.closed/);
  f.producer.fence(); // Sync scan also covers commits before fs.watch delivers its callback.
  await f.publication(f.history.map((interest) => interest.key));
  const recovered = f.journal();
  await manager.close(f.owner.id, f.info.id);
  assert.notEqual(f.journal(), recovered);
  const receipt = manager.read(f.owner.id, f.info.id).commands[0];
  assert.equal(receipt.state, 'failed');
  assert.equal(receipt.outcome, 'interrupted');
  assert.equal(receipt.submitted, false);
  f.producer.fence();
  await f.publication(f.history.map((interest) => interest.key));
  assert.equal(f.probes(), 1, 'Journal activity must not start another account probe');
});

test('actual native account sampling publishes only profile keys without journal or registration writes', async (t) => {
  const f = await actualProducerFixture(t);
  const journal = f.journal();
  const registration = f.registration();
  const observedAt = '2026-10-24T00:01:00.000Z';
  f.changeAccount(observedAt);
  t.mock.timers.tick(60_000); // Existing source collector, not a panel-read timer.
  for (let turn = 0; f.sampledAt() !== observedAt; turn++) {
    assert(turn < 100, 'Shared structured account sample did not complete');
    await Promise.resolve();
  }
  assert.equal(f.probes(), 2);
  assert.equal(f.journal(), journal);
  assert.equal(f.registration(), registration);
  await f.publication([f.profiles.key]);
});

test('actual native source stop invalidates both private families and refuses late reads without replay', async (t) => {
  const f = await actualProducerFixture(t);
  f.producer.stop();
  await f.publication([...f.history.map((interest) => interest.key), f.profiles.key]);
  let routes = 0;
  await assert.rejects(
    f.source.read(
      f.connection,
      f.history,
      async () => {
        routes++;
        return f.journal();
      },
      () => ({}),
    ),
    { code: 'NATIVE_SOURCE_UNAVAILABLE' },
  );
  assert.equal(routes, 0);
  f.producer.stop();
  await f.publication([]);
});
