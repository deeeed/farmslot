import assert from 'node:assert/strict';
import test from 'node:test';

import {
  gatewayProfileForConnection,
  gatewayProfileForUrl,
  selectInitialGatewayConnection,
} from './gateway-profile-selection';
import type { GatewayProfile } from './gateway-profiles';

const profiles: GatewayProfile[] = [
  {
    id: 'secret-profile',
    name: 'Secret profile',
    url: 'ws://secret.test:7777/ws',
    kind: 'remote',
    authMode: 'token',
    secretStorageKey: 'secret-key',
  },
];

test('restart never attaches a profile credential to an unrelated saved URL', () => {
  assert.deepEqual(
    selectInitialGatewayConnection(profiles, 'ws://unrelated.test:7777/ws', 'secret-profile', ''),
    {
      url: 'ws://unrelated.test:7777/ws',
      profile: null,
    },
  );
});

test('restart matches credentials only for the exact normalized endpoint', () => {
  assert.equal(gatewayProfileForUrl(profiles, ' ws://secret.test:7777/ws '), profiles[0]);
  assert.equal(gatewayProfileForUrl(profiles, 'ws://secret.test:7777/other'), null);
  assert.equal(
    gatewayProfileForConnection(profiles, 'ws://secret.test:7777/other', 'secret-profile'),
    null,
  );
});
