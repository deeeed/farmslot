import assert from 'node:assert/strict';
import test from 'node:test';

import { describeProbe, probeGatewayAuth } from './gateway-auth.js';
import { effectiveCredential } from './gateway-client.js';

test('effectiveCredential never discovers a credential for an uncredentialed target', () => {
  assert.equal(effectiveCredential(undefined), null);
  assert.deepEqual(effectiveCredential({ token: 'profile-secret' }), { token: 'profile-secret' });
  assert.equal(effectiveCredential(null), null);
});

test('probeGatewayAuth classifies a refused connection as unreachable', async () => {
  // Port 1 on loopback refuses immediately — typed transport error, not inactive.
  const started = Date.now();
  const probe = await probeGatewayAuth('ws://127.0.0.1:1', undefined, 2_000);
  assert.equal(probe.state, 'unreachable');
  assert.ok(probe.detail);
  // A probe reports it at once rather than waiting out a reload.
  assert.ok(Date.now() - started < 1_000);
});

test('auth status description reports transport and authority as separate axes', () => {
  const description = describeProbe(
    'farm',
    { url: 'ws://127.0.0.1:7777', authMode: 'token', secret: 'hidden' },
    {
      state: 'authenticated',
      authMode: 'token',
      principal: {
        id: 'sam',
        displayName: 'sam',
        subjectKind: 'person',
        roles: [{ role: 'operator', scope: { kind: 'global' } }],
      },
    },
  );
  assert.match(description, /authenticated \(token\)/u);
  assert.match(description, /as sam \[operator:global\]/u);
  assert.doesNotMatch(description, /hidden/u);
});
