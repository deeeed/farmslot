import assert from 'node:assert/strict';
import test from 'node:test';

import { initializeDesktopConnection } from './desktop-connection.js';
import {
  GATEWAY_SESSION_EXPIRY_STORAGE_KEY,
  GATEWAY_SIGNED_OUT_STORAGE_KEY,
  GATEWAY_TOKEN_STORAGE_KEY,
} from './gateway-url.js';

test('sign-out disconnects, rejects pending work, survives refresh and allows deliberate login', async (t) => {
  const keys = ['window', 'localStorage', 'location', 'document', 'WebSocket'] as const;
  const descriptors = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const store = new Map<string, string>();
  class Socket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    static instances: Socket[] = [];
    static holdAuth = false;
    static tokens: unknown[] = [];
    readyState = 0;
    constructor() {
      super();
      Socket.instances.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }
    send(text: string) {
      const request = JSON.parse(text);
      if (request.method !== 'auth.connect') return;
      Socket.tokens.push(request.params?.token);
      if (Socket.holdAuth) return;
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'res',
              id: request.id,
              ok: true,
              payload: {
                ok: true,
                capabilities: { workspaceAccess: 'farm' },
                principal: {
                  id: 'operator',
                  subject: { type: 'person' },
                  roles: [{ role: 'admin', scope: { kind: 'global' } }],
                },
              },
            }),
          }),
        ),
      );
    }
    close() {
      this.readyState = 3;
    }
    gatewayRestart() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }
  const values = {
    window: {},
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
    location: { protocol: 'http:', host: 'localhost:1234', hash: '', hostname: 'localhost' },
    document: { cookie: '' },
    WebSocket: Socket,
  };
  for (const key of keys)
    Object.defineProperty(globalThis, key, { configurable: true, value: values[key] });
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
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
  assert.ok(Number(originalExpiry) > Date.now());
  // Reload/browser restart creates a fresh client from durable storage.
  client.disconnect();
  client = new GatewayClient();
  client.connect();
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  await flush();
  assert.equal(client.connectionState, 'connected');
  assert.equal(Socket.tokens.at(-1), 'first-device-secret');
  assert.equal(store.get(GATEWAY_SESSION_EXPIRY_STORAGE_KEY), originalExpiry);
  // A gateway deploy can interrupt auth.connect itself, not just an established socket.
  Socket.holdAuth = true;
  Socket.instances.at(-1)!.gatewayRestart();
  client.reconnect();
  await flush();
  assert.equal(client.connectionState, 'connecting');
  Socket.instances.at(-1)!.gatewayRestart();
  await flush();
  Socket.holdAuth = false;
  client.reconnect();
  await flush();
  assert.equal(client.connectionState, 'connected');
  assert.equal(client.authenticatedPrincipalId, 'operator');
  assert.equal(Socket.tokens.at(-1), 'first-device-secret');
  assert.equal(store.get(GATEWAY_SESSION_EXPIRY_STORAGE_KEY), originalExpiry);
  const socketCountBeforeSignOut = Socket.instances.length;
  const pending = assert.rejects(client.request('pending.work'), /Signed out/);
  await client.signOut();
  await pending;
  assert.equal(client.connectionState, 'auth_required');
  assert.equal(client.authenticatedPrincipalId, null);
  assert.equal(client.workspaceAccess, 'none');
  assert.equal(Socket.instances[0].readyState, 3);
  assert.equal(store.has(GATEWAY_TOKEN_STORAGE_KEY), false);
  assert.equal(store.has(GATEWAY_SESSION_EXPIRY_STORAGE_KEY), false);
  assert.equal(store.get(GATEWAY_SIGNED_OUT_STORAGE_KEY), 'true');
  client.connect();
  client.reconnect();
  assert.equal(Socket.instances.length, socketCountBeforeSignOut);
  const refreshed = new GatewayClient();
  t.after(() => refreshed.disconnect());
  refreshed.connect();
  assert.equal(refreshed.connectionState, 'auth_required');
  assert.equal(Socket.instances.length, socketCountBeforeSignOut);
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
  assert.equal(expired.connectionState, 'auth_required');
  assert.match(expired.authError?.message ?? '', /expired/);
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
