import assert from 'node:assert/strict';
import test from 'node:test';

import { initializeDesktopConnection } from './desktop-connection.js';
import { GATEWAY_SIGNED_OUT_STORAGE_KEY, GATEWAY_TOKEN_STORAGE_KEY } from './gateway-url.js';

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
  const client = new GatewayClient();
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
  const pending = assert.rejects(client.request('pending.work'), /Signed out/);
  await client.signOut();
  await pending;
  assert.equal(client.connectionState, 'auth_required');
  assert.equal(client.authenticatedPrincipalId, null);
  assert.equal(client.workspaceAccess, 'none');
  assert.equal(Socket.instances[0].readyState, 3);
  assert.equal(store.has(GATEWAY_TOKEN_STORAGE_KEY), false);
  assert.equal(store.get(GATEWAY_SIGNED_OUT_STORAGE_KEY), 'true');
  client.connect();
  client.reconnect();
  assert.equal(Socket.instances.length, 1);
  const refreshed = new GatewayClient();
  t.after(() => refreshed.disconnect());
  refreshed.connect();
  assert.equal(refreshed.connectionState, 'auth_required');
  assert.equal(Socket.instances.length, 1);
  await refreshed.setAuthCredentials({ token: 'replacement-device-secret' });
  const reconnected = new Promise<void>((resolve) =>
    refreshed.onConnectionChange((s) => {
      if (s === 'connected') resolve();
    }),
  );
  refreshed.connect();
  await reconnected;
  assert.equal(refreshed.authenticatedPrincipalId, 'operator');
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
});
