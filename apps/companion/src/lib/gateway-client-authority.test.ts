import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { AppStateStatus } from 'react-native';

import {
  createSourceCommandClient,
  Events,
  type GatewayAuthConnectResult,
  Methods,
  type ResponseFrame,
  SourceStatusController,
} from '@farmslot/protocol';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  createResourceCacheTransport,
  type GatewayResourceCache,
  resourceQuery,
} from '@farmslot/protocol/client-cache';

import { sourceStatusFixture } from '../../../../packages/protocol/test/fixtures/source-status';

const appStateListeners = new Set<(state: AppStateStatus) => void>();
mock.module('react-native', {
  namedExports: {
    AppState: {
      addEventListener: (_event: string, listener: (state: AppStateStatus) => void) => {
        appStateListeners.add(listener);
        return { remove: () => appStateListeners.delete(listener) };
      },
    },
  },
});

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static sockets: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<{ id: string; method: string; params: unknown }> = [];
  constructor(readonly url: string) {
    Socket.sockets.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  response(id: string, payload: unknown, resourceState?: ResponseFrame['resourceState']) {
    this.onmessage?.({
      data: JSON.stringify({ type: 'res', id, ok: true, payload, resourceState }),
    });
  }
  failure(id: string, error: NonNullable<ResponseFrame['error']>) {
    this.onmessage?.({ data: JSON.stringify({ type: 'res', id, ok: false, error }) });
  }
  event(event: string, payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type: 'event', event, payload }) });
  }
}

function auth(
  id: string,
  access: 'farm' | 'native' | 'none',
  subjectKind: 'person' | 'service' = 'service',
): GatewayAuthConnectResult {
  return {
    ok: true,
    clientKind: 'companion',
    authMode: 'token',
    authenticatedAt: Date.now(),
    principal: { id, displayName: id, subjectKind, roles: [] },
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      gatewayPing: true,
      workspaceAccess: access,
    },
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test(
  'native shared collection transport preserves active, history and decision deadlines',
  { timeout: 4000 },
  async (t) => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    const { GatewayClient } = await import('./gateway-client');
    const client = new GatewayClient('ws://localhost:19777', { token: 'admin' });
    try {
      client.connect();
      const socket = Socket.sockets.at(-1)!;
      socket.open();
      socket.response(socket.sent[0].id, auth('admin', 'farm'));
      await settle();
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
      const outcomes: string[] = [];
      const reads = [
        client.requestResource('run.list', { active: true }).catch((error: Error) => {
          outcomes.push(error.message);
        }),
        client.requestResource('run.list', { limit: 80, sort: 'newest' }).catch((error: Error) => {
          outcomes.push(error.message);
        }),
        client.requestResource('decision.list', {}).catch((error: Error) => {
          outcomes.push(error.message);
        }),
      ];
      await settle();
      t.mock.timers.tick(20_000);
      await settle();
      assert.equal(outcomes.length, 1);
      assert.match(outcomes[0], /20000/);
      t.mock.timers.tick(10_000);
      await settle();
      assert.equal(outcomes.length, 2);
      assert.match(outcomes[1], /30000/);
      t.mock.timers.tick(30_000);
      await Promise.all(reads);
      assert.equal(outcomes.length, 3);
      assert.match(outcomes[2], /60000/);
    } finally {
      client.disconnect();
      globalThis.WebSocket = original;
    }
  },
);

test(
  'shared Sources reads survive slow receipt verification while ordinary reads still time out',
  { timeout: 4000 },
  async (t) => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    const { GatewayClient } = await import('./gateway-client');
    const client = new GatewayClient('ws://localhost:19777', { token: 'admin' });
    try {
      client.connect();
      const socket = Socket.sockets.at(-1)!;
      socket.open();
      socket.response(socket.sent[0].id, auth('admin', 'farm'));
      await settle();
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
      const sources = client.requestResource('sources.status', {}).then(
        (value) => ({ value }),
        (error: Error) => ({ error }),
      );
      const sourcesId = socket.sent.at(-1)!.id;
      const runs = assert.rejects(
        client.requestResource('run.get', { runId: 'ordinary' }),
        /timed out/,
      );
      t.mock.timers.tick(31_000);
      const resourceState = { epoch: 'test', dependencies: [] };
      socket.response(sourcesId, { configured: true }, resourceState);
      await runs;
      assert.deepEqual(await sources, { value: { data: { configured: true }, resourceState } });
    } finally {
      client.disconnect();
      globalThis.WebSocket = original;
    }
  },
);

for (const code of ['TIMEOUT', 'AUTH_FAILED']) {
  test(`native reconnect ${code} ${code === 'TIMEOUT' ? 'preserves' : 'deletes'} cached observations`, async () => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    const { GatewayClient } = await import('./gateway-client');
    const client = new GatewayClient('ws://localhost:19777', { token: 'admin' });
    const store = createMemoryResourceStore();
    const cache = createGatewayResourceCache({
      store,
      transport: createResourceCacheTransport(client, () => ({
        id: client.connectionGeneration,
        connected: client.connectionState === 'connected',
        gatewayUrl: 'ws://localhost:19777',
        authentication: client.authenticatedConnection,
      })),
    });
    try {
      client.connect();
      let socket = Socket.sockets.at(-1)!;
      socket.open();
      const result = auth('operator', 'farm');
      result.principal!.generation = 0;
      result.capabilities.resourceChanges = { version: 1, epoch: 'test', versionLists: false };
      socket.response(socket.sent[0].id, result);
      await settle();
      const query = { ...resourceQuery<{ value: string }>('sources.status'), persisted: true };
      const done = cache.retry(query);
      await settle();
      socket.response(
        socket.sent.at(-1)!.id,
        { value: 'cached' },
        {
          epoch: 'test',
          dependencies: [{ key: { family: 'sources', scope: 'farm' }, revision: 0 }],
        },
      );
      assert.equal((await done).status, 'ready');
      client.reconnect();
      socket = Socket.sockets.at(-1)!;
      socket.open();
      socket.failure(socket.sent.at(-1)!.id, { code, message: code });
      await settle();
      const state = await cache.retry(query);
      assert.equal(store.deleted, code === 'AUTH_FAILED');
      assert.equal(state.data?.value, code === 'TIMEOUT' ? 'cached' : undefined);
      if (code === 'TIMEOUT') assert.equal(state.status, 'stale');
      if (code === 'TIMEOUT') {
        await client.clearAccountSession();
        client.disconnect();
        await cache.retry(query);
        assert.equal(
          store.deleted,
          true,
          'sign-out while disconnected must delete the retained store',
        );
        assert.equal(cache.read(query).data, undefined);
      }
    } finally {
      await cache.dispose();
      client.disconnect();
      globalThis.WebSocket = original;
    }
  });
}

test('resource frames preserve stamps and cancellation covers connection waits and pending reads', async () => {
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const { GatewayClient } = await import('./gateway-client');
  const client = new GatewayClient('ws://localhost:19777', { token: 'admin' });
  try {
    const preAborted = new AbortController();
    preAborted.abort();
    const before = Socket.sockets.length;
    await assert.rejects(
      client.requestResource('sources.status', {}, preAborted.signal),
      /aborted/,
    );
    assert.equal(Socket.sockets.length, before);
    const waiting = new AbortController();
    const cancelledWait = assert.rejects(
      client.requestResource('sources.status', {}, waiting.signal),
      /aborted/,
    );
    waiting.abort();
    await cancelledWait;
    const socket = Socket.sockets.at(-1)!;
    socket.open();
    socket.response(socket.sent[0].id, auth('admin', 'farm'));
    await settle();
    const stamp = {
      epoch: 'test',
      dependencies: [{ key: { family: 'sources' as const, scope: 'farm' as const }, revision: 2 }],
    };
    const resource = client.requestResource('sources.status', {});
    socket.response(socket.sent.at(-1)!.id, { revision: 2 }, stamp);
    assert.deepEqual(await resource, { data: { revision: 2 }, resourceState: stamp });
    const ordinary = client.request('sources.status');
    socket.response(socket.sent.at(-1)!.id, { revision: 2 }, stamp);
    assert.deepEqual(await ordinary, { revision: 2 });
    const controller = new AbortController();
    const pending = assert.rejects(
      client.requestResource('sources.status', {}, controller.signal),
      /aborted/,
    );
    const id = socket.sent.at(-1)!.id;
    controller.abort();
    socket.response(id, { revision: 1 }, stamp);
    await pending;
  } finally {
    client.disconnect();
    globalThis.WebSocket = originalSocket;
  }
});

test('native authentication is published before listeners and never sends a farm bootstrap request', async () => {
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const { GatewayClient } = await import('./gateway-client');
  const client = new GatewayClient('ws://localhost:19777', { token: 'owner' });
  const observed: string[] = [];
  client.onConnectionChange((state) => {
    if (state === 'connected')
      observed.push(`${client.authenticatedPrincipal?.id}:${client.workspaceAccess}`);
  });
  try {
    client.connect();
    const socket = Socket.sockets.at(-1)!;
    socket.open();
    socket.response(socket.sent[0].id, auth('owner-a', 'native'));
    await settle();
    assert.deepEqual(observed, ['owner-a:native']);
    await assert.rejects(client.request(Methods.FLEET_STATUS), /cannot access farm/);
    await assert.rejects(
      client.request(Methods.NATIVE_SESSION_READ, { worker: { runId: 'run' } }),
      /cannot access farm/,
    );
    const request = client.request(Methods.NATIVE_SESSION_LIST);
    socket.response(socket.sent.at(-1)!.id, { sessions: [] });
    assert.deepEqual(await request, { sessions: [] });
    assert.deepEqual(
      socket.sent.map((frame) => frame.method),
      [Methods.AUTH_CONNECT, Methods.NATIVE_SESSION_LIST],
    );
    let leaked = false;
    client.subscribe('fleet.updated', () => {
      leaked = true;
    });
    socket.event('fleet.updated', { marker: 'protected' });
    assert.equal(leaked, false);
  } finally {
    client.disconnect();
    globalThis.WebSocket = originalSocket;
  }
});

test('settled old account responses and queued requests cannot cross a credential replacement', async () => {
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const { GatewayClient } = await import('./gateway-client');
  const client = new GatewayClient('ws://localhost:19777', { token: 'admin' });
  try {
    client.connect();
    const old = Socket.sockets.at(-1)!;
    old.open();
    old.response(old.sent[0].id, auth('admin', 'farm'));
    await settle();
    const request = assert.rejects(client.request(Methods.FLEET_STATUS), /identity changed/);
    old.response(old.sent.at(-1)!.id, { marker: 'old-admin' });
    client.setConnection('ws://localhost:19777', { token: 'owner' });
    assert.equal(client.authenticatedPrincipal, null);
    assert.equal(client.workspaceAccess, 'none');
    await request;
    const current = Socket.sockets.at(-1)!;
    current.open();
    current.response(current.sent[0].id, auth('owner-a', 'native'));
    await settle();
    const authenticatedId = () => client.authenticatedPrincipal?.id;
    assert.equal(authenticatedId(), 'owner-a');
    assert.deepEqual(
      current.sent.map((frame) => frame.method),
      [Methods.AUTH_CONNECT],
    );
  } finally {
    client.disconnect();
    globalThis.WebSocket = originalSocket;
  }
});

test('policy revocation clears authority before disconnect listeners and farm compatibility remains', async () => {
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const { GatewayClient } = await import('./gateway-client');
  const client = new GatewayClient('ws://localhost:19777', { token: 'admin' });
  try {
    client.connect();
    const socket = Socket.sockets.at(-1)!;
    socket.open();
    socket.response(socket.sent[0].id, auth('admin', 'farm'));
    await settle();
    const request = client.request(Methods.FLEET_STATUS);
    socket.response(socket.sent.at(-1)!.id, { fleet: 'allowed' });
    assert.deepEqual(await request, { fleet: 'allowed' });
    let disconnectedAccess: string | undefined;
    client.onConnectionChange((state) => {
      if (state === 'disconnected') disconnectedAccess = client.workspaceAccess;
    });
    socket.close(1008);
    assert.equal(disconnectedAccess, 'none');
    assert.equal(client.authenticatedPrincipal, null);
  } finally {
    client.disconnect();
    globalThis.WebSocket = originalSocket;
  }
});

test('native RPC rejection preserves its code, details and next action', async () => {
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const { GatewayClient } = await import('./gateway-client');
  const client = new GatewayClient('ws://localhost:19777');
  try {
    client.connect();
    const socket = Socket.sockets.at(-1)!;
    socket.open();
    socket.response(socket.sent[0].id, auth('admin', 'farm'));
    await settle();
    const rejection = {
      code: 'SOURCE_STATE_STALE',
      message: 'Source pins changed before applying this request.',
      details: { expectedPinRevision: 2, pinRevision: 3 },
      userAction: 'Review current source pins and try again.',
    };
    const request = assert.rejects(client.request(Methods.SOURCES_PIN), (error: Error) => {
      assert(error instanceof Error);
      for (const [key, value] of Object.entries(rejection))
        assert.deepEqual(Reflect.get(error, key), value);
      return true;
    });
    socket.failure(socket.sent.at(-1)!.id, rejection);
    await request;
  } finally {
    client.disconnect();
    globalThis.WebSocket = originalSocket;
  }
});

test('native stale source rejection releases editing and prepares a fresh command', async () => {
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const { GatewayClient } = await import('./gateway-client');
  const client = new GatewayClient('ws://localhost:19777');
  let cache: GatewayResourceCache | undefined;
  const stamp = (revision = 0) => ({
    epoch: 'native-source-test',
    dependencies: [{ key: { family: 'sources' as const, scope: 'farm' as const }, revision }],
  });
  try {
    client.connect();
    const socket = Socket.sockets.at(-1)!;
    socket.open();
    const authenticated = auth('admin', 'farm');
    authenticated.principal!.generation = 0;
    authenticated.capabilities.resourceChanges = {
      version: 1,
      epoch: 'native-source-test',
      versionLists: false,
    };
    socket.response(socket.sent[0].id, authenticated);
    await settle();
    cache = createGatewayResourceCache({
      transport: createResourceCacheTransport(client, () => ({
        id: client.connectionGeneration,
        connected: client.connectionState === 'connected',
        gatewayUrl: client.gatewayUrl,
        authentication: client.authenticatedConnection,
      })),
    });
    const controller = new SourceStatusController(
      createSourceCommandClient(
        (method, params) => client.request(method, params),
        () => cache,
      ),
      {
        connectionKey: 'farm',
        target: { scope: 'farm', targetId: 'farm' },
        actions: ['pin'],
      },
      cache,
    );
    const refresh = controller.refresh();
    await settle();
    socket.response(socket.sent.at(-1)!.id, sourceStatusFixture(), stamp());
    await refresh;
    controller.select({ sourceId: 'pack', selection: 'branch', ref: 'experiment' });
    const stale = controller.apply('pin', 'pack');
    await settle();
    socket.response(socket.sent.at(-1)!.id, sourceStatusFixture(), stamp());
    await settle();
    const oldCommand = socket.sent.at(-1)!;
    assert.equal(oldCommand.method, Methods.SOURCES_PIN);
    socket.failure(oldCommand.id, {
      code: 'SOURCE_STATE_STALE',
      message: 'Source pins changed before applying this request.',
      details: { pinRevision: 3 },
    });
    await stale;
    assert.equal(controller.getSnapshot().pending, undefined);
    assert.equal(controller.getSnapshot().canRetry, false);
    assert.equal(controller.getSnapshot().canEdit, true);
    assert(controller.getSnapshot().operationError?.includes('Source pins changed'));

    const freshStatus = { ...sourceStatusFixture(), pinRevision: 3 };
    const refreshed = controller.refresh();
    await settle();
    socket.response(socket.sent.at(-1)!.id, freshStatus, stamp());
    await refreshed;
    assert(controller.getSnapshot().operationError?.includes('Source pins changed'));
    controller.select({ sourceId: 'pack', selection: 'branch', ref: 'experiment/fresh' });
    const fresh = controller.apply('pin', 'pack');
    await settle();
    socket.response(socket.sent.at(-1)!.id, freshStatus, stamp());
    await settle();
    const freshCommand = socket.sent.at(-1)!;
    assert.equal(freshCommand.method, Methods.SOURCES_PIN);
    const oldParams = oldCommand.params as Record<string, unknown>;
    const freshParams = freshCommand.params as Record<string, unknown>;
    assert.notEqual(freshParams.operationId, oldParams.operationId);
    assert.equal(freshParams.expectedPinRevision, 3);
    assert.equal(freshParams.ref, 'experiment/fresh');
    socket.response(freshCommand.id, { operationId: freshParams.operationId });
    await fresh;
    assert.equal(
      socket.sent.at(-1)!.method,
      Methods.SOURCES_PIN,
      'A command acknowledgement does not start a settle read',
    );
    socket.event(Events.RESOURCE_CHANGED, {
      version: 1,
      epoch: 'native-source-test',
      changes: [{ key: { family: 'sources', scope: 'farm' }, revision: 1, kind: 'updated' }],
    });
    await settle();
    assert.equal(socket.sent.at(-1)!.method, Methods.SOURCES_STATUS);
    socket.response(socket.sent.at(-1)!.id, freshStatus, stamp(1));
    await settle();
    assert.equal(controller.getSnapshot().operationError, undefined);
    assert.equal(controller.getSnapshot().pending, undefined);
    assert.equal(controller.getSnapshot().canEdit, true);
    controller.dispose();
  } finally {
    await cache?.dispose();
    client.disconnect();
    globalThis.WebSocket = originalSocket;
  }
});

function personGrant() {
  const now = Date.now();
  return {
    session: {
      id: 'a'.repeat(32),
      principalId: 'person-owner',
      principalGeneration: 0,
      deviceName: 'Companion',
      deviceKind: 'companion' as const,
      createdAt: new Date(now).toISOString(),
      lastRefreshedAt: new Date(now).toISOString(),
      refreshExpiresAt: new Date(now + 30 * 86400_000).toISOString(),
      revokedAt: null,
    },
    refreshToken: `fsr_${'a'.repeat(32)}_${'r'.repeat(43)}`,
    accessToken: `fsa_${'a'.repeat(32)}_${'s'.repeat(43)}`,
    accessExpiresAt: new Date(now + 3600_000).toISOString(),
  };
}

test('a native foreground read deletes cached data after its attempted refresh confirms session end', async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const { GatewayClient } = await import('./gateway-client');
  const grant = personGrant();
  const client = new GatewayClient('ws://localhost:19777', {
    sessionStorage: {
      load: async () => ({ session: grant.session, refreshToken: grant.refreshToken }),
      save: async () => {},
    },
    personSessionRequired: true,
  });
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({
    store,
    transport: createResourceCacheTransport(client, () => ({
      id: client.connectionGeneration,
      connected: client.connectionState === 'connected',
      gatewayUrl: 'ws://localhost:19777',
      authentication: client.authenticatedConnection,
    })),
  });
  try {
    client.connect();
    const socket = Socket.sockets.at(-1)!;
    socket.open();
    await settle();
    socket.response(socket.sent.at(-1)!.id, grant);
    await settle();
    const result = auth('person-owner', 'farm', 'person');
    result.principal!.generation = 0;
    result.capabilities.resourceChanges = { version: 1, epoch: 'test', versionLists: false };
    socket.response(socket.sent.at(-1)!.id, result);
    await settle();
    const query = { ...resourceQuery<{ private: string }>('sources.status'), persisted: true };
    const first = cache.retry(query);
    await settle();
    socket.response(
      socket.sent.at(-1)!.id,
      { private: 'old principal' },
      { epoch: 'test', dependencies: [{ key: { family: 'sources', scope: 'farm' }, revision: 0 }] },
    );
    assert.equal((await first).status, 'ready');
    const refused = cache.retry(query);
    await settle();
    socket.failure(socket.sent.at(-1)!.id, {
      code: 'AUTH_SESSION_ENDED',
      message: 'Refresh required',
    });
    await settle();
    assert.equal(socket.sent.at(-1)!.method, Methods.AUTH_SESSION_REFRESH);
    socket.failure(socket.sent.at(-1)!.id, {
      code: 'AUTH_SESSION_ENDED',
      message: 'Session revoked',
    });
    await refused;
    await cache.retry(query);
    assert.equal(client.resourceConnectionReason, 'session-ended');
    assert.equal(client.authenticatedConnection, undefined);
    assert.equal(cache.read(query).data, undefined);
    assert(store.deleted);
  } finally {
    await cache.dispose();
    client.disconnect();
    globalThis.WebSocket = original;
  }
});

test('a saved person login renews through the gateway after app reload and reconnect', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  const { GatewayClient } = await import('./gateway-client');
  const grant = personGrant();
  let saved = { session: grant.session, refreshToken: grant.refreshToken };
  const storage = {
    load: async () => saved,
    save: async (value: typeof saved | null) => {
      if (value) saved = value;
    },
  };
  let client = new GatewayClient('ws://localhost:19777', {
    sessionStorage: storage,
    personSessionRequired: true,
  });
  const authenticate = async () => {
    client.connect();
    const socket = Socket.sockets.at(-1)!;
    socket.open();
    await settle();
    assert.equal(socket.sent[0].method, Methods.AUTH_SESSION_REFRESH);
    socket.response(socket.sent[0].id, personGrant());
    await settle();
    assert.equal(socket.sent.at(-1)!.method, Methods.AUTH_CONNECT);
    socket.response(socket.sent.at(-1)!.id, auth('person-owner', 'native', 'person'));
    await settle();
    assert.equal(client.workspaceAccess, 'native');
    return socket;
  };
  try {
    await authenticate();
    assert.ok(client.httpAuthHeaders.Authorization?.startsWith('Bearer fsa_'));
    client.disconnect();
    client = new GatewayClient('ws://localhost:19777', {
      sessionStorage: storage,
      personSessionRequired: true,
    });
    const socket = await authenticate();
    socket.close(1012);
    client.reconnect();
    await authenticate();
  } finally {
    client.disconnect();
    if (original) Object.defineProperty(globalThis, 'WebSocket', original);
    else Reflect.deleteProperty(globalThis, 'WebSocket');
  }
});

test('a superseded person refresh cannot cross a selected service profile', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  const { GatewayClient } = await import('./gateway-client');
  const grant = personGrant();
  let writes = 0;
  const client = new GatewayClient('ws://localhost:19777', {
    sessionStorage: {
      load: async () => ({ session: grant.session, refreshToken: grant.refreshToken }),
      save: async () => {
        writes += 1;
      },
    },
    personSessionRequired: true,
  });
  try {
    client.connect();
    const old = Socket.sockets.at(-1)!;
    old.open();
    await settle();
    await client.setConnection('ws://localhost:19778', { token: 'selected-service' }, true);
    const selected = Socket.sockets.at(-1)!;
    selected.open();
    selected.response(selected.sent[0].id, auth('service-owner', 'farm'));
    await settle();
    old.response(old.sent[0].id, grant);
    await settle();
    assert.equal(client.authenticatedPrincipal?.id, 'service-owner');
    assert.equal(writes, 0);
  } finally {
    client.disconnect();
    if (original) Object.defineProperty(globalThis, 'WebSocket', original);
    else Reflect.deleteProperty(globalThis, 'WebSocket');
  }
});

test('a slow visual judgment remains pending until its response or disconnection', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  const { GatewayClient } = await import('./gateway-client');
  const client = new GatewayClient('ws://localhost:19777', { token: 'fixture-person' });
  t.after(() => {
    client.disconnect();
    if (original) Object.defineProperty(globalThis, 'WebSocket', original);
  });
  client.connect();
  const socket = Socket.sockets.at(-1)!;
  socket.open();
  socket.response(socket.sent[0].id, auth('fixture-person', 'farm'));
  await settle();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const pending = client.request(Methods.RUN_REVIEW_VISUAL_CLAIM, { runId: 'fixture-run' }, null);
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  t.mock.timers.tick(20_000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  socket.response(socket.sent.at(-1)!.id, { receipt: 'saved-once' });
  assert.deepEqual(await pending, { receipt: 'saved-once' });
  const interrupted = assert.rejects(
    client.request(Methods.RUN_REVIEW_VISUAL_CLAIM, {}, null),
    /disconnected/i,
  );
  client.disconnect();
  await interrupted;
});

// The held-connection clock reads backgroundPaused when the client reports the disconnect.
test(
  'a background pause is flagged before its disconnect and cleared before the reconnect',
  { timeout: 4000 },
  async () => {
    const original = globalThis.WebSocket;
    Object.assign(globalThis, { WebSocket: Socket });
    const { GatewayClient } = await import('./gateway-client');
    const client = new GatewayClient('ws://localhost:19778', { token: 'admin' });
    const seen: Array<{ state: string; paused: boolean }> = [];
    try {
      client.connect();
      const socket = Socket.sockets.at(-1)!;
      socket.open();
      socket.response(socket.sent[0].id, auth('admin', 'farm'));
      await settle();
      client.onConnectionChange((state) => seen.push({ state, paused: client.backgroundPaused }));
      appStateListeners.forEach((listener) => listener('background'));
      appStateListeners.forEach((listener) => listener('active'));
      assert.deepEqual(seen.slice(0, 2), [
        { state: 'disconnected', paused: true },
        { state: 'connecting', paused: false },
      ]);
    } finally {
      client.disconnect();
      Object.assign(globalThis, { WebSocket: original });
    }
  },
);
