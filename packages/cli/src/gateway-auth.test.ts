import assert from 'node:assert/strict';
import test from 'node:test';

import { probeGatewayAuth } from './gateway-auth.js';
import { effectiveCredential } from './gateway-client.js';

test('effectiveCredential: profile credential beats env, null disables discovery', () => {
  const env = { token: 'env-secret' };
  // Non-profile target → env discovery allowed.
  assert.deepEqual(
    effectiveCredential(undefined, () => env),
    env,
  );
  // Profile with its own credential → exactly that credential.
  assert.deepEqual(
    effectiveCredential({ token: 'profile-secret' }, () => env),
    { token: 'profile-secret' },
  );
  // Profile WITHOUT credential → null, env secret must never leak to it.
  assert.equal(
    effectiveCredential(null, () => env),
    null,
  );
});

test('probeGatewayAuth classifies a refused connection as unreachable', async () => {
  // Port 1 on loopback refuses immediately — typed transport error, not inactive.
  const probe = await probeGatewayAuth('ws://127.0.0.1:1', undefined, 2_000);
  assert.equal(probe.state, 'unreachable');
  assert.ok(probe.detail);
});
