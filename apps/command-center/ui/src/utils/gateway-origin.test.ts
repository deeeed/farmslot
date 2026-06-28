import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GATEWAY_PASSWORD_STORAGE_KEY,
  GATEWAY_TOKEN_STORAGE_KEY,
  parseHostedGatewayConnection,
  persistGatewayAuthForHttp,
} from '../gateway-url.js';

import { gatewayApiUrl, gatewayHttpOrigin } from './gateway-origin.js';

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
      'http://localhost:7777/api/file?slotId=s1&path=a.png&token=hosted-password',
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
