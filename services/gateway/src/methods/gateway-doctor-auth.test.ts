import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGatewayAuthRuntime, initializeGatewayIdentity } from '../security/auth.js';

import { gatewayDoctor } from './gateway-doctor.js';

test('gateway doctor distinguishes every ADR-051 identity lifecycle state', async () => {
  const solo = runtimeFor('127.0.0.1');
  assert.equal((await gatewayDoctor({ run: false }, solo)).identityState, 'solo-mode');

  const exposedBeforeLatch = runtimeFor('0.0.0.0');
  assert.equal(
    (await gatewayDoctor({ run: false }, exposedBeforeLatch)).identityState,
    'never-latched-non-loopback',
  );

  const activatedWithAdmin = runtimeFor('127.0.0.1');
  const admin = activatedWithAdmin.writer.createPrincipal(
    { type: 'person', displayName: 'owner' },
    [{ role: 'admin', scope: { kind: 'global' } }],
  );
  activatedWithAdmin.writer.issueCredential(admin.id, 'owner');
  assert.equal(
    (await gatewayDoctor({ run: false }, activatedWithAdmin)).identityState,
    'activated-with-admin',
  );

  const activatedWithoutAdmin = runtimeFor('127.0.0.1');
  activatedWithoutAdmin.writer.latchActivation();
  assert.equal(
    (await gatewayDoctor({ run: false }, activatedWithoutAdmin)).identityState,
    'activated-without-admin',
  );
});

function runtimeFor(host: string) {
  const runtime = createGatewayAuthRuntime({
    FARMSLOT_HOME: mkdtempSync(join(tmpdir(), 'farmslot-doctor-auth-')),
    GATEWAY_HOST: host,
  });
  initializeGatewayIdentity(runtime, { host });
  return runtime;
}
