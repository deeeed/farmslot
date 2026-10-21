import assert from 'node:assert/strict';
import test from 'node:test';

import { installFakeGateway } from './testing/fake-gateway.js';
import { initializeDesktopConnection } from './desktop-connection.js';
import {
  GATEWAY_SESSION_EXPIRY_STORAGE_KEY,
  GATEWAY_SIGNED_OUT_STORAGE_KEY,
  GATEWAY_TOKEN_STORAGE_KEY,
} from './gateway-url.js';

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

test('a pending judgment waits past the ordinary deadline for the server result', async (t) => {
  const fake = installFakeGateway(t);
  const { GatewayClient } = await import('./gateway-client.js');
  const client = new GatewayClient();
  t.after(() => client.disconnect());
  const connected = new Promise<void>((resolve) =>
    client.onConnectionChange((state) => {
      if (state === 'connected') resolve();
    }),
  );
  await client.setAuthCredentials({ token: 'pending-judgment-fixture' });
  client.connect();
  await connected;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const request = client.request(
    'run.reviewVisualClaim',
    { runId: 'fixture-run' },
    { timeout: null },
  );
  void request.then(
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
  assert.equal(settled, false, 'the server is still refreshing the package');
  fake.respond('run.reviewVisualClaim', { receipt: 'saved-once' });
  assert.deepEqual(await request, { receipt: 'saved-once' });
  const interrupted = assert.rejects(
    client.request('pending.work', {}, { timeout: null }),
    /disconnected/i,
  );
  client.disconnect();
  await interrupted;
});
