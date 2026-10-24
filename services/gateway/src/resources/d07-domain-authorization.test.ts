import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

import type { ResourceKey } from '@farmslot/protocol/client-cache';

import { GatewayMethodError } from '../core/method-error.js';
import { createGatewayAuthRuntime, type GatewayAuthRuntime } from '../security/auth.js';
import type { ClientState } from '../server/client-state.js';

let allow = true;
const methods: string[] = [];
mock.module('../security/authorization.js', {
  namedExports: {
    authorizeGatewayMethod(_runtime: GatewayAuthRuntime, _state: ClientState, method: string) {
      methods.push(method);
      if (!allow) throw new GatewayMethodError('AUTH_FORBIDDEN', 'Authority revoked');
    },
  },
});
const { canReadResourceKey } = await import('./authorization.js');
// The real authorizer is separately covered. This boundary must choose the owning read and fail closed.
const state: ClientState = {
  authenticated: true,
} as ClientState;
test('domain notifications use owning method authorization and reveal no private assessment/foreign copilot keys', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'd07-key-authorization-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
  const keys: ResourceKey[] = [
    { family: 'pr-automation', scope: 'farm' },
    { family: 'assessment', scope: 'farm' },
    { family: 'analytics', scope: 'farm' },
    { family: 'copilot', ownerId: 'gateway-copilot' },
    { family: 'copilot', ownerId: 'gateway-copilot', sessionId: 'global' },
  ];
  for (const key of keys) assert.equal(canReadResourceKey(runtime, state, key), true);
  assert.deepEqual(methods, [
    'prWatch.list',
    'assessment.list',
    'analytics.query',
    'copilot.status',
    'chat.sessionContext',
  ]);
  const before = methods.length;
  assert.equal(
    canReadResourceKey(runtime, state, {
      family: 'assessment',
      scope: 'farm',
      assessmentId: 'private',
    }),
    false,
  );
  assert.equal(
    canReadResourceKey(runtime, state, { family: 'copilot', ownerId: 'foreign' }),
    false,
  );
  assert.equal(methods.length, before);
  allow = false;
  for (const key of keys) assert.equal(canReadResourceKey(runtime, state, key), false);
});
