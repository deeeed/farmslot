import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import {
  commandCenterUrlError,
  resolveSharedViewLink,
} from '@farmslot/protocol/surfaces/view-links';

test('the actual Expo URL implementation preserves the shared route and refuses loopback spellings', () => {
  const require = createRequire(import.meta.url);
  const expoRequire = createRequire(require.resolve('expo/package.json'));
  const implementation: unknown = expoRequire('whatwg-url-minimum');
  assert.ok(
    implementation &&
      typeof implementation === 'object' &&
      'URL' in implementation &&
      'URLSearchParams' in implementation &&
      typeof implementation.URL === 'function' &&
      typeof implementation.URLSearchParams === 'function',
  );
  const originalUrl = Object.getOwnPropertyDescriptor(globalThis, 'URL');
  const originalParams = Object.getOwnPropertyDescriptor(globalThis, 'URLSearchParams');
  assert.ok(originalUrl && originalParams);
  try {
    Object.defineProperty(globalThis, 'URL', { ...originalUrl, value: implementation.URL });
    Object.defineProperty(globalThis, 'URLSearchParams', {
      ...originalParams,
      value: implementation.URLSearchParams,
    });
    const link = resolveSharedViewLink(
      {
        companion: {
          pathname: '/workspace/run/retained-run/timeline',
          params: {},
        },
      },
      'https://cc.example.org/operations/',
    );
    assert.deepEqual(link, {
      status: 'available',
      route: '#run/retained-run?panel=timeline',
      url: 'https://cc.example.org/operations/#run/retained-run?panel=timeline&sharedView=1',
    });
    for (const value of [
      'https://127.1',
      'https://2130706433',
      'https://[::1]',
      'https://[::ffff:127.0.0.1]',
      'https://user:secret@cc.example.org',
    ])
      assert.ok(commandCenterUrlError(value), value);
  } finally {
    Object.defineProperty(globalThis, 'URL', originalUrl);
    Object.defineProperty(globalThis, 'URLSearchParams', originalParams);
  }
});
