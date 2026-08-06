import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GATEWAY_PASSWORD_STORAGE_KEY,
  GATEWAY_TOKEN_STORAGE_KEY,
  parseHostedGatewayConnection,
  persistGatewayAuthForHttp,
} from '../gateway-url.js';

import {
  gatewayApiUrl,
  gatewayHttpFetch,
  gatewayHttpOrigin,
  gatewayProxiedFetchUrl,
  gatewayResourceUrl,
} from './gateway-origin.js';

test('gatewayHttpOrigin falls back to the current host on local pages', () => {
  assert.equal(
    gatewayHttpOrigin({ protocol: 'https:', hostname: 'command.local' }),
    'https://command.local:7777',
  );
});

test('gatewayHttpOrigin defaults for non-browser tests', () => {
  assert.equal(gatewayHttpOrigin(), 'http://localhost:7777');
});

test('gatewayApiUrl keeps relative paths on the selected gateway origin', () => {
  assert.equal(
    gatewayApiUrl('/api/run-artifact?runId=1&path=a'),
    'http://localhost:7777/api/run-artifact?runId=1&path=a',
  );
});

test('gatewayApiUrl authenticates artifact URLs with hosted fragment tokens', () => {
  withMockLocalStorage(() => {
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        gateways: ['ws://127.0.0.1:7788/ws'],
        token: 'hosted-token',
      }),
    ).toString('base64url');

    const hosted = parseHostedGatewayConnection(`#doctor?connect=${payload}`);
    persistGatewayAuthForHttp(hosted);

    assert.equal(localStorage.getItem(GATEWAY_TOKEN_STORAGE_KEY), 'hosted-token');
    assert.equal(
      gatewayApiUrl('/api/run-artifact?runId=1&path=a'),
      'http://localhost:7777/api/run-artifact?runId=1&path=a&token=hosted-token',
    );
  });
});

test('gatewayApiUrl can authenticate artifact URLs with stored passwords', () => {
  withMockLocalStorage(() => {
    localStorage.setItem(GATEWAY_PASSWORD_STORAGE_KEY, 'hosted-password');

    assert.equal(
      gatewayApiUrl('/api/file?slotId=s1&path=a.png'),
      'http://localhost:7777/api/file?slotId=s1&path=a.png&password=hosted-password',
    );
  });
});

test('gatewayApiUrl does not append gateway credentials to off-gateway absolute URLs', () => {
  withMockLocalStorage(() => {
    localStorage.setItem(GATEWAY_TOKEN_STORAGE_KEY, 'hosted-token');

    assert.equal(
      gatewayApiUrl('https://example.com/artifact.png'),
      'https://example.com/artifact.png',
    );
  });
});

test('gatewayResourceUrl matches gatewayProxiedFetchUrl for browser media URLs', () => {
  withMockLocalStorage(() => {
    localStorage.setItem(GATEWAY_TOKEN_STORAGE_KEY, 'dev-token');
    const location = {
      href: 'http://localhost:5175/#family/demo',
      origin: 'http://localhost:5175',
      pathname: '/',
    };
    const path = '/api/run-artifact?runId=1&path=a.png';
    withMockWindow(location, () => {
      assert.equal(gatewayResourceUrl(path), gatewayProxiedFetchUrl(path, location));
    });
  });
});

test('gatewayProxiedFetchUrl authenticates and strips gateway origin for local dev pages', () => {
  withMockLocalStorage(() => {
    localStorage.setItem(GATEWAY_TOKEN_STORAGE_KEY, 'dev-token');

    assert.equal(
      gatewayProxiedFetchUrl('/api/run-artifact?runId=1&path=a.diff', {
        href: 'http://localhost:5175/#family/demo',
        origin: 'http://localhost:5175',
        pathname: '/',
      }),
      '/api/run-artifact?runId=1&path=a.diff&token=dev-token',
    );
  });
});

test('gatewayProxiedFetchUrl keeps hosted /cc artifact URLs absolute with token', () => {
  withMockLocalStorage(() => {
    localStorage.setItem(GATEWAY_TOKEN_STORAGE_KEY, 'hosted-token');

    assert.equal(
      gatewayProxiedFetchUrl('/api/run-artifact?runId=1&path=a', {
        href: 'https://farmslot.io/cc/#family/demo',
        origin: 'https://farmslot.io',
        pathname: '/cc/',
      }),
      'http://localhost:7777/api/run-artifact?runId=1&path=a&token=hosted-token',
    );
  });
});

test('gatewayHttpFetch uses transport-specific headers without query credential injection', async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = new Map<string, string>([[GATEWAY_TOKEN_STORAGE_KEY, 'dev-token']]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        return store.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        store.set(key, value);
      },
      removeItem(key: string): void {
        store.delete(key);
      },
    },
  });

  const calls: Array<{ url: string; authorization: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('Authorization'),
    });
    return Promise.resolve(new Response('ok', { status: 200 }));
  }) as typeof fetch;

  try {
    await gatewayHttpFetch('/api/run-artifact?runId=1&path=a.diff', undefined, {
      href: 'http://localhost:5175/#family/demo',
      origin: 'http://localhost:5175',
      pathname: '/',
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      url: '/api/run-artifact?runId=1&path=a.diff',
      authorization: 'Bearer dev-token',
    });
    store.delete(GATEWAY_TOKEN_STORAGE_KEY);
    store.set(GATEWAY_PASSWORD_STORAGE_KEY, 'legacy password');
    await gatewayHttpFetch('/api/file?slotId=s1&path=a.txt', undefined, {
      href: 'http://localhost:5175/#slot/s1',
      origin: 'http://localhost:5175',
      pathname: '/',
    });
    assert.deepEqual(calls[1], {
      url: '/api/file?slotId=s1&path=a.txt',
      authorization: `Basic ${Buffer.from(':legacy password').toString('base64')}`,
    });
    await gatewayHttpFetch('https://example.com/not-gateway');
    assert.deepEqual(calls[2], {
      url: 'https://example.com/not-gateway',
      authorization: null,
    });
    assert.equal(
      gatewayProxiedFetchUrl('/api/run-artifact?runId=1&path=a.diff&token=dev-token', {
        href: 'http://localhost:5175/#family/demo',
        origin: 'http://localhost:5175',
        pathname: '/',
      }),
      '/api/run-artifact?runId=1&path=a.diff&token=dev-token',
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousStorage) {
      Object.defineProperty(globalThis, 'localStorage', previousStorage);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
});

function withMockWindow(
  location: { href: string; origin: string; pathname: string },
  fn: () => void,
): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location },
  });
  try {
    fn();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, 'window', previous);
    } else {
      delete (globalThis as { window?: Window }).window;
    }
  }
}

function withMockLocalStorage(fn: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        return store.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        store.set(key, value);
      },
      removeItem(key: string): void {
        store.delete(key);
      },
    },
  });
  try {
    fn();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, 'localStorage', previous);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
}
