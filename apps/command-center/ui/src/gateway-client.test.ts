import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  createResourceCacheTransport,
  resourceQuery,
} from '@farmslot/protocol/client-cache';

import { installFakeGateway } from './testing/fake-gateway.js';
import { initializeDesktopConnection } from './desktop-connection.js';
import {
  GATEWAY_SESSION_EXPIRY_STORAGE_KEY,
  GATEWAY_SIGNED_OUT_STORAGE_KEY,
  GATEWAY_TOKEN_STORAGE_KEY,
} from './gateway-url.js';

test(
  'shared Sources reads survive slow receipt verification while ordinary reads still time out',
  { timeout: 4000 },
  async (t) => {
    const fake = installFakeGateway(t);
    const { GatewayClient, gateway } = await import('./gateway-client.js');
    const client = new GatewayClient('ws://localhost:1234/ws', { token: 'proof' });
    t.after(() => {
      client.disconnect();
      gateway.disconnect();
    });
    client.connect();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const socket = fake.sockets.at(-1)!;
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const sources = client.requestResource('sources.status', {}).then(
      (value) => ({ value }),
      (error: Error) => ({ error }),
    );
    const sourcesId = socket.sent.at(-1)!.id;
    const runs = assert.rejects(client.requestResource('run.list', {}), /timed out/);
    t.mock.timers.tick(31_000);
    const resourceState = { epoch: 'test', dependencies: [] };
    socket.response(sourcesId, { configured: true }, resourceState);
    await runs;
    assert.deepEqual(await sources, { value: { data: { configured: true }, resourceState } });
  },
);

test(
  'shared run evidence reads keep their existing 60-second deadline',
  { timeout: 4000 },
  async (t) => {
    const fake = installFakeGateway(t);
    const { GatewayClient, gateway } = await import('./gateway-client.js');
    const client = new GatewayClient('ws://localhost:1234/ws', { token: 'proof' });
    t.after(() => {
      client.disconnect();
      gateway.disconnect();
    });
    client.connect();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const socket = fake.sockets.at(-1)!;
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let complete = false;
    const reading = client
      .requestResource('run.recipeRunsForRun', { runId: 'retained' })
      .then((value) => {
        complete = true;
        return value;
      });
    const id = socket.sent.at(-1)!.id;
    t.mock.timers.tick(59_000);
    await Promise.resolve();
    assert.equal(complete, false);
    socket.response(id, { recipeRuns: [], selectedRecipeRunId: null });
    assert.deepEqual(await reading, {
      data: { recipeRuns: [], selectedRecipeRunId: null },
      resourceState: undefined,
    });
    const timedOut = assert.rejects(
      client.requestResource('run.recipeRunsForRun', { runId: 'slow' }),
      /60000ms/,
    );
    t.mock.timers.tick(60_000);
    await timedOut;
  },
);

for (const code of ['TIMEOUT', 'AUTH_FAILED']) {
  test(`browser reconnect ${code} ${code === 'TIMEOUT' ? 'preserves' : 'deletes'} cached observations`, async (t) => {
    const fake = installFakeGateway(t);
    fake.authPayload = {
      ok: true,
      authMode: 'token',
      principal: { id: 'operator', generation: 0, subjectKind: 'service', roles: [] },
      capabilities: {
        workspaceAccess: 'farm',
        resourceChanges: { version: 1, epoch: 'test', versionLists: false },
      },
    };
    const { GatewayClient, gateway } = await import('./gateway-client.js');
    const client = new GatewayClient('ws://localhost:1234/ws', { token: 'proof' });
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    client.connect();
    await settle();
    const store = createMemoryResourceStore();
    const cache = createGatewayResourceCache({
      store,
      transport: createResourceCacheTransport(client, () => ({
        id: client.connectionEpoch,
        connected: client.connectionState === 'connected',
        gatewayUrl: client.gatewayUrl,
        authentication: client.authenticatedConnection,
      })),
    });
    t.after(async () => {
      await cache.dispose();
      client.disconnect();
      gateway.disconnect();
    });
    const query = { ...resourceQuery<{ value: string }>('sources.status'), persisted: true };
    const done = cache.retry(query);
    await settle();
    let socket = fake.sockets.at(-1)!;
    socket.response(
      socket.sent.at(-1)!.id,
      { value: 'cached' },
      { epoch: 'test', dependencies: [{ key: { family: 'sources', scope: 'farm' }, revision: 0 }] },
    );
    assert.equal((await done).status, 'ready');
    fake.holdAuth = true;
    client.reconnect();
    await settle();
    socket = fake.sockets.at(-1)!;
    socket.failure(socket.sent.at(-1)!.id, { code, message: code });
    await settle();
    const state = await cache.retry(query);
    assert.equal(store.deleted, code === 'AUTH_FAILED');
    assert.equal(state.data?.value, code === 'TIMEOUT' ? 'cached' : undefined);
    if (code === 'TIMEOUT') assert.equal(state.status, 'stale');
  });
}

for (const refreshResult of ['session-ended', 'roles', 'workspace-access', 'generation'] as const) {
  test(`a foreground refresh with ${refreshResult} clears the previous authority's cache`, async (t) => {
    const fake = installFakeGateway(t);
    const { GatewayClient, gateway } = await import('./gateway-client.js');
    const { CommandCenterPersonSessionStorage } = await import('./person-session-storage.js');
    const now = Date.now();
    const grant = {
      session: {
        id: 'a'.repeat(32),
        principalId: 'person-cache',
        principalGeneration: 0,
        deviceName: 'Browser',
        deviceKind: 'command-center' as const,
        createdAt: new Date(now).toISOString(),
        lastRefreshedAt: new Date(now).toISOString(),
        refreshExpiresAt: new Date(now + 86400_000).toISOString(),
        revokedAt: null,
      },
      refreshToken: `fsr_${'a'.repeat(32)}_${'r'.repeat(43)}`,
      accessToken: `fsa_${'a'.repeat(32)}_${'s'.repeat(43)}`,
      accessExpiresAt: new Date(now + 3600_000).toISOString(),
    };
    const url = 'ws://localhost:1234/ws';
    await new CommandCenterPersonSessionStorage([url]).save({
      session: grant.session,
      refreshToken: grant.refreshToken,
    });
    const authentication = {
      ok: true,
      authMode: 'token',
      principal: {
        id: 'person-cache',
        generation: 0,
        subjectKind: 'person',
        displayName: 'Person',
        roles: [],
      },
      capabilities: {
        workspaceAccess: 'farm',
        resourceChanges: { version: 1, epoch: 'test', versionLists: false },
      },
    };
    fake.authPayload = authentication;
    const client = new GatewayClient(url);
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    client.connect();
    await settle();
    const socket = fake.sockets.at(-1)!;
    assert.equal(socket.sent.at(-1)!.method, 'auth.session.refresh');
    socket.response(socket.sent.at(-1)!.id, grant);
    await settle();
    assert.equal(client.connectionState, 'connected');
    const store = createMemoryResourceStore();
    const cache = createGatewayResourceCache({
      store,
      transport: createResourceCacheTransport(client, () => ({
        id: client.resourceConnectionId,
        connected: client.connectionState === 'connected',
        gatewayUrl: url,
        authentication: client.authenticatedConnection,
      })),
    });
    t.after(async () => {
      await cache.dispose();
      client.disconnect();
      gateway.disconnect();
    });
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
    const socketId = client.resourceConnectionId;
    await settle();
    socket.failure(socket.sent.at(-1)!.id, {
      code: 'AUTH_SESSION_ENDED',
      message: 'Refresh required',
    });
    await settle();
    assert.equal(socket.sent.at(-1)!.method, 'auth.session.refresh');
    if (refreshResult === 'session-ended') {
      socket.failure(socket.sent.at(-1)!.id, {
        code: 'AUTH_SESSION_ENDED',
        message: 'Session revoked',
      });
    } else {
      fake.authPayload = {
        ...authentication,
        principal: {
          ...authentication.principal,
          generation: refreshResult === 'generation' ? 1 : 0,
          roles: refreshResult === 'roles' ? [{ role: 'operator', scope: { kind: 'global' } }] : [],
        },
        capabilities: {
          ...authentication.capabilities,
          workspaceAccess: refreshResult === 'workspace-access' ? 'native' : 'farm',
        },
      };
      socket.response(socket.sent.at(-1)!.id, grant);
      await settle();
      assert.equal(
        client.resourceConnectionId,
        socketId,
        'Authentication refreshed on the same socket',
      );
      assert.equal(fake.sockets.at(-1), socket);
      assert(store.deleted, 'The refresh must notify the cache before the retried read replies');
      assert.equal(cache.read(query).data, undefined);
      socket.response(
        socket.sent.at(-1)!.id,
        { private: 'current authority' },
        {
          epoch: 'test',
          dependencies: [{ key: { family: 'sources', scope: 'farm' }, revision: 0 }],
        },
      );
    }
    await refused;
    if (refreshResult === 'session-ended') {
      await cache.retry(query);
      assert.equal(client.resourceConnectionReason, 'session-ended');
      assert.equal(client.authenticatedConnection, undefined);
      assert.equal(cache.read(query).data, undefined);
    }
    assert(store.deleted);
  });
}

test('resource reads retain frame stamps, ordinary reads retain payloads and abort drops late replies', async (t) => {
  const fake = installFakeGateway(t);
  const { GatewayClient, gateway } = await import('./gateway-client.js');
  const client = new GatewayClient();
  t.after(() => {
    client.disconnect();
    gateway.disconnect();
  });
  await client.setAuthCredentials({ token: 'resource-test' });
  const connected = new Promise<void>((resolve) =>
    client.onConnectionChange((state) => {
      if (state === 'connected') resolve();
    }),
  );
  client.connect();
  await connected;
  const socket = fake.sockets.at(-1)!;
  const stamp = {
    epoch: 'test',
    dependencies: [{ key: { family: 'sources', scope: 'farm' }, revision: 2 }],
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
  const before = socket.sent.length;
  await assert.rejects(client.requestResource('sources.status', {}, controller.signal), /aborted/);
  assert.equal(socket.sent.length, before);
});

test('sign-out disconnects, rejects pending work, survives refresh and allows deliberate login', async (t) => {
  const fakeGateway = installFakeGateway(t, 'operator');
  const { store } = fakeGateway;
  const { GatewayClient, gateway } = await import('./gateway-client.js');
  let client = new GatewayClient();
  t.after(() => {
    client.disconnect();
    gateway.disconnect();
  });
  const connected = new Promise<void>((resolve) =>
    client.onConnectionChange((s) => {
      if (s === 'connected') resolve();
    }),
  );
  await client.setAuthCredentials({ token: 'first-device-secret' });
  client.connect();
  await connected;
  assert.equal(client.authenticatedPrincipalId, 'operator');
  const originalExpiry = store.get(GATEWAY_SESSION_EXPIRY_STORAGE_KEY);
  assert.equal(originalExpiry, undefined);
  // Reload/browser restart creates a fresh client from durable storage.
  client.disconnect();
  client = new GatewayClient();
  client.connect();
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  await flush();
  assert.equal(client.connectionState, 'connected');
  assert.equal(fakeGateway.tokens.at(-1), 'first-device-secret');
  assert.equal(store.get(GATEWAY_SESSION_EXPIRY_STORAGE_KEY), originalExpiry);
  // A gateway deploy can interrupt auth.connect itself, not just an established socket.
  fakeGateway.holdAuth = true;
  fakeGateway.restart();
  client.reconnect();
  await flush();
  assert.equal(client.connectionState, 'connecting');
  fakeGateway.restart();
  await flush();
  fakeGateway.holdAuth = false;
  client.reconnect();
  await flush();
  assert.equal(client.connectionState, 'connected');
  assert.equal(client.authenticatedPrincipalId, 'operator');
  assert.equal(fakeGateway.tokens.at(-1), 'first-device-secret');
  assert.equal(store.get(GATEWAY_SESSION_EXPIRY_STORAGE_KEY), originalExpiry);
  const socketCountBeforeSignOut = fakeGateway.sockets.length;
  const pending = assert.rejects(client.request('pending.work'), /Signed out/);
  await client.signOut();
  await pending;
  assert.equal(client.connectionState, 'auth_required');
  assert.equal(client.authenticatedPrincipalId, null);
  assert.equal(client.workspaceAccess, 'none');
  assert.equal(fakeGateway.sockets[0].readyState, 3);
  assert.equal(store.has(GATEWAY_TOKEN_STORAGE_KEY), false);
  assert.equal(store.has(GATEWAY_SESSION_EXPIRY_STORAGE_KEY), false);
  assert.equal(store.get(GATEWAY_SIGNED_OUT_STORAGE_KEY), 'true');
  client.connect();
  client.reconnect();
  assert.equal(fakeGateway.sockets.length, socketCountBeforeSignOut);
  const refreshed = new GatewayClient();
  t.after(() => refreshed.disconnect());
  refreshed.connect();
  assert.equal(refreshed.connectionState, 'auth_required');
  assert.equal(fakeGateway.sockets.length, socketCountBeforeSignOut);
  await refreshed.setAuthCredentials({ token: 'replacement-device-secret' });
  const reconnected = new Promise<void>((resolve) =>
    refreshed.onConnectionChange((s) => {
      if (s === 'connected') resolve();
    }),
  );
  refreshed.connect();
  await reconnected;
  assert.equal(refreshed.authenticatedPrincipalId, 'operator');
  const validExpiry = store.get(GATEWAY_SESSION_EXPIRY_STORAGE_KEY)!;
  store.set(GATEWAY_SESSION_EXPIRY_STORAGE_KEY, String(Date.now() - 1));
  const expired = new GatewayClient();
  t.after(() => expired.disconnect());
  expired.connect();
  await flush();
  assert.equal(expired.connectionState, 'connected');
  assert.equal(store.get(GATEWAY_TOKEN_STORAGE_KEY), 'replacement-device-secret');
  store.set(GATEWAY_SESSION_EXPIRY_STORAGE_KEY, validExpiry);
  // Desktop secure-store failure must leave the authenticated session intact.
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      farmslotDesktop: {
        loadConnection: async () => ({ url: 'ws://localhost:1234/ws', token: 'desktop-secret' }),
        saveConnection: async () => {
          throw new Error('Keychain unavailable');
        },
      },
    },
  });
  await initializeDesktopConnection();
  await assert.rejects(refreshed.signOut(), /Keychain unavailable/);
  assert.equal(refreshed.connectionState, 'connected');
  assert.equal(refreshed.authenticatedPrincipalId, 'operator');
  const desktopSaves: Array<{ token?: string; rememberMe?: boolean; url: string }> = [];
  window.farmslotDesktop!.loadConnection = async () => ({
    url: 'ws://localhost:1234/ws',
    token: 'new-settings-secret',
    rememberMe: true,
  });
  window.farmslotDesktop!.saveConnection = async (value) => {
    desktopSaves.push(value);
  };
  await initializeDesktopConnection();
  store.set(GATEWAY_SIGNED_OUT_STORAGE_KEY, 'true');
  const desktopLogin = new GatewayClient();
  t.after(() => desktopLogin.disconnect());
  const desktopConnected = new Promise<void>((resolve) =>
    desktopLogin.onConnectionChange((state) => {
      if (state === 'connected') resolve();
    }),
  );
  desktopLogin.connect();
  await desktopConnected;
  assert.equal(desktopLogin.authenticatedPrincipalId, 'operator');
  await desktopLogin.signOut();
  assert.deepEqual(desktopSaves.at(-1), { url: 'ws://localhost:1234/ws', rememberMe: true });
});

test('browser device-session writes are scoped, verified and refuse stale profile writers', async (t) => {
  const { CommandCenterPersonSessionStorage } = await import('./person-session-storage.js');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const first = new CommandCenterPersonSessionStorage(['ws://one/ws']);
  const stale = new CommandCenterPersonSessionStorage(['ws://one/ws']);
  const second = new CommandCenterPersonSessionStorage(['ws://two/ws']);
  const auth = {
    refreshToken: `fsr_${'a'.repeat(32)}_${'b'.repeat(43)}`,
    session: {
      id: 'a'.repeat(32),
      principalId: 'person',
      principalGeneration: 0,
      deviceName: 'Browser',
      deviceKind: 'command-center' as const,
      createdAt: '2026-10-16T00:00:00.000Z',
      lastRefreshedAt: '2026-10-16T00:00:00.000Z',
      refreshExpiresAt: '2026-11-15T00:00:00.000Z',
      revokedAt: null,
    },
  };
  first.beginValidation();
  await first.save(auth);
  assert.equal(values.size, 0);
  await first.commit();
  assert.equal(first.required, true);
  assert.deepEqual(await first.load(), auth);
  assert.equal(await second.load(), null);
  await assert.rejects(stale.save(null), /sign-in changed/);
  const tabA = new CommandCenterPersonSessionStorage(['ws://one/ws']);
  const tabB = new CommandCenterPersonSessionStorage(['ws://one/ws']);
  const refreshed = {
    ...auth,
    session: {
      ...auth.session,
      lastRefreshedAt: '2026-10-17T00:00:00.000Z',
      refreshExpiresAt: '2026-11-16T00:00:00.000Z',
    },
  };
  await tabB.save(refreshed);
  assert.deepEqual(await tabA.load(), refreshed);
  await first.save(auth); // A late response may not move the same authority's metadata backwards.
  assert.deepEqual(await tabB.load(), refreshed);
  await tabA.save(null);
  await assert.rejects(tabB.save(refreshed), /sign-in changed/);
  assert.equal(new CommandCenterPersonSessionStorage(['ws://one/ws']).required, true);
  assert.equal(await new CommandCenterPersonSessionStorage(['ws://one/ws']).load(), null);
});

test('one-use hosted invitations are distinct from stored bearer credentials', async () => {
  const { parseHostedGatewayConnection } = await import('./gateway-url.js');
  const payload = Buffer.from(
    JSON.stringify({ v: 1, gateways: ['ws://localhost:7777/ws'], code: 'one-use-code' }),
  ).toString('base64url');
  const hosted = parseHostedGatewayConnection(`#fleet?connect=${payload}`);
  assert.equal(hosted.code, 'one-use-code');
  assert.equal(hosted.token, undefined);
  assert.equal(hosted.password, undefined);
});

test('a request the gateway never answers rejects as a typed timeout', async (t) => {
  installFakeGateway(t);
  const { GatewayClient } = await import('./gateway-client.js');
  const { GatewayRequestTimeoutError } = await import('./gateway-request-timeout.js');
  const client = new GatewayClient();
  t.after(() => client.disconnect());
  const connected = new Promise<void>((resolve) =>
    client.onConnectionChange((s) => {
      if (s === 'connected') resolve();
    }),
  );
  await client.setAuthCredentials({ token: 'timeout-device-secret' });
  client.connect();
  await connected;
  await assert.rejects(
    client.request('run.get', { runId: 'run-a' }, 20),
    (error: unknown) =>
      error instanceof GatewayRequestTimeoutError &&
      error.message === 'Request run.get timed out after 20ms',
  );
});
