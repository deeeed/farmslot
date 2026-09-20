import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import {
  gatewayApiUrl,
  gatewayHttpFetch,
  gatewayHttpOrigin,
  gatewayResourceUrl,
} from './utils/gateway-origin.js';
import {
  type DesktopConnection,
  type FarmslotDesktopBridge,
  getDesktopConnection,
  initializeDesktopConnection,
  isDesktopClient,
  saveDesktopCredentials,
} from './desktop-connection.js';
import {
  GATEWAY_PASSWORD_STORAGE_KEY,
  GATEWAY_TOKEN_STORAGE_KEY,
  GATEWAY_URL_STORAGE_KEY,
  persistGatewayAuthForHttp,
  readGatewayAuth,
  replaceStoredGatewayAuthForHttp,
} from './gateway-url.js';

function mockEnvironment(t: TestContext, bridge?: FarmslotDesktopBridge) {
  const store = new Map<string, string>();
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      farmslotDesktop: bridge,
      location: {
        href: 'http://127.0.0.1:43210/cc/',
        origin: 'http://127.0.0.1:43210',
        pathname: '/cc/',
      },
    },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  });
  t.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  return store;
}

function bridgeFor(connection: DesktopConnection | null): FarmslotDesktopBridge {
  return {
    loadConnection: async () => connection,
    saveConnection: async () => undefined,
    onResume: () => () => undefined,
  };
}

test('web keeps its stored credentials and replacement behavior without a desktop bridge', async (t) => {
  const store = mockEnvironment(t);
  await initializeDesktopConnection();
  assert.equal(isDesktopClient(), false);
  assert.equal(getDesktopConnection(), null);
  persistGatewayAuthForHttp({ token: 'browser-token' });
  assert.equal(readGatewayAuth().token, 'browser-token');
  replaceStoredGatewayAuthForHttp({ password: 'browser-password' });
  assert.equal(store.has(GATEWAY_TOKEN_STORAGE_KEY), false);
  assert.equal(readGatewayAuth().password, 'browser-password');
  replaceStoredGatewayAuthForHttp({});
  assert.equal(store.size, 0);
});

test('desktop waits for its connection and ignores browser credentials and gateway history', async (t) => {
  const connection = { url: 'wss://gateway.example/ws', token: 'desktop-token' };
  let resolveConnection!: (value: DesktopConnection) => void;
  const bridge = bridgeFor(null);
  bridge.loadConnection = () =>
    new Promise((resolve) => {
      resolveConnection = resolve;
    });
  const store = mockEnvironment(t, bridge);
  store.set(GATEWAY_URL_STORAGE_KEY, 'ws://old-gateway:7777/ws');
  store.set(GATEWAY_TOKEN_STORAGE_KEY, 'old-token');
  const initialStore = new Map(store);
  const initializing = initializeDesktopConnection();
  assert.equal(getDesktopConnection(), null);
  assert.equal(readGatewayAuth().token, undefined);
  resolveConnection(connection);
  await initializing;
  assert.deepEqual(getDesktopConnection(), connection);
  assert.equal(gatewayHttpOrigin(), 'https://gateway.example');
  assert.equal(
    gatewayResourceUrl('/api/file?path=example.png'),
    'https://gateway.example/api/file?path=example.png&token=desktop-token',
  );
  assert.equal(gatewayApiUrl('https://outside.example/image'), 'https://outside.example/image');
  persistGatewayAuthForHttp({ token: 'must-not-persist' });
  replaceStoredGatewayAuthForHttp({ password: 'must-not-persist' });
  assert.deepEqual(store, initialStore);
  assert.equal(readGatewayAuth().token, 'desktop-token');
});

test('desktop credential replacement awaits secure persistence and preserves auth on failure', async (t) => {
  const connection = { url: 'ws://127.0.0.1:7777/ws', token: 'old-token' };
  const bridge = bridgeFor(connection);
  const store = mockEnvironment(t, bridge);
  await initializeDesktopConnection();
  let finishSave!: () => void;
  let saved: DesktopConnection | undefined;
  bridge.saveConnection = (value) => {
    saved = value;
    return new Promise((resolve) => {
      finishSave = resolve;
    });
  };
  const saving = saveDesktopCredentials({ password: 'new-password' });
  assert.equal(readGatewayAuth().token, 'old-token');
  finishSave();
  await saving;
  assert.deepEqual(saved, { url: connection.url, password: 'new-password' });
  assert.equal(readGatewayAuth().token, undefined);
  assert.equal(readGatewayAuth().password, 'new-password');
  assert.equal(store.has(GATEWAY_PASSWORD_STORAGE_KEY), false);
  bridge.saveConnection = async () => {
    throw new Error('Keychain unavailable');
  };
  await assert.rejects(saveDesktopCredentials({ token: 'rejected-token' }), /Keychain unavailable/);
  assert.equal(readGatewayAuth().password, 'new-password');
  assert.equal(store.size, 0);
});

test('desktop HTTP uses in-memory auth headers and never attaches them to another origin', async (t) => {
  mockEnvironment(
    t,
    bridgeFor({ url: 'https://gateway.example/ws', password: 'desktop-password' }),
  );
  await initializeDesktopConnection();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, authorization: new Headers(init?.headers).get('Authorization') });
    return new Response('ok');
  });
  await gatewayHttpFetch('/api/file?path=notes.txt');
  await gatewayHttpFetch('https://outside.example/file');
  assert.deepEqual(calls, [
    {
      url: 'https://gateway.example/api/file?path=notes.txt',
      authorization: `Basic ${Buffer.from(':desktop-password').toString('base64')}`,
    },
    { url: 'https://outside.example/file', authorization: null },
  ]);
});

test('desktop startup rejects missing settings and Keychain errors without browser fallback', async (t) => {
  const bridge = bridgeFor(null);
  mockEnvironment(t, bridge);
  await assert.rejects(initializeDesktopConnection(), /Choose a gateway/);
  bridge.loadConnection = async () => {
    throw new Error('Keychain unavailable');
  };
  await assert.rejects(initializeDesktopConnection(), /Keychain unavailable/);
  assert.equal(getDesktopConnection(), null);
});
