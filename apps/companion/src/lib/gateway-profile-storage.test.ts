import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseGatewayProfilesFromStorage,
  sanitizeGatewayProfilesForStorage,
} from './gateway-profile-storage';
import type { GatewayProfile } from './gateway-profiles';

test('parseGatewayProfilesFromStorage tolerates empty and malformed storage', () => {
  assert.deepEqual(parseGatewayProfilesFromStorage(null), []);
  assert.deepEqual(parseGatewayProfilesFromStorage('{"profiles":['), []);
  assert.deepEqual(parseGatewayProfilesFromStorage('{"id":"not-array"}'), []);
});

test('parseGatewayProfilesFromStorage returns saved profile arrays', () => {
  const saved: GatewayProfile[] = [
    {
      id: 'remote-test',
      name: 'Remote Test',
      url: 'wss://example.test/ws',
      kind: 'remote',
      authMode: 'token',
    },
  ];

  assert.deepEqual(parseGatewayProfilesFromStorage(JSON.stringify(saved)), saved);
});

test('sanitizeGatewayProfilesForStorage strips preset secrets before AsyncStorage persistence', () => {
  assert.deepEqual(
    sanitizeGatewayProfilesForStorage([
      {
        id: 'remote-test',
        name: 'Remote Test',
        url: 'wss://example.test/ws',
        kind: 'remote',
        authMode: 'token',
        secretStorageKey: 'secret-key',
        presetSecret: 'do-not-store',
      },
    ]),
    [
      {
        id: 'remote-test',
        name: 'Remote Test',
        url: 'wss://example.test/ws',
        kind: 'remote',
        authMode: 'token',
        secretStorageKey: 'secret-key',
      },
    ],
  );
});
