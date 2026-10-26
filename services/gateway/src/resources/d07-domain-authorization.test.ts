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
      return { id: 'reader' };
    },
  },
});
const { canReadResourceKey, canReadVisibleModelPreferenceKey } = await import('./authorization.js');
// The real authorizer is separately covered. This boundary must choose the owning read and fail closed.
const state: ClientState = {
  authenticated: true,
} as ClientState;
test('domain notifications use owning method authorization and reveal no private assessment/foreign copilot keys', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'd07-key-authorization-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
  const keys: ResourceKey[] = [
    { family: 'gateway-update', scope: 'gateway' },
    { family: 'upstream', integration: 'github', queryId: 'pr.list:{}' },
    { family: 'upstream', integration: 'github', queryId: 'pr.list:{"project":"one"}' },
    { family: 'upstream', integration: 'github', queryId: 'config.githubAccounts:{}' },
    { family: 'upstream', integration: 'github', queryId: 'pr.status:{"pr":7,"project":"one"}' },
    { family: 'upstream', integration: 'github', queryId: 'pr.forSlot:{"slotId":"s1"}' },
    {
      family: 'upstream',
      integration: 'github',
      queryId: 'pr.reviewComments:{"pr":7,"repo":"org/one"}',
    },
    {
      family: 'upstream',
      integration: 'providers',
      queryId: 'runner.modelCatalog:{"runner":"cursor"}',
    },
    { family: 'upstream', integration: 'providers', queryId: 'providerAccounts.snapshot:{}' },
    {
      family: 'upstream',
      integration: 'providers',
      queryId: 'providerAccounts.snapshot:{"machines":["macwork"]}',
    },
    { family: 'pr-automation', scope: 'farm' },
    { family: 'assessment', scope: 'farm' },
    { family: 'analytics', scope: 'farm' },
    { family: 'copilot', ownerId: 'gateway-copilot' },
    { family: 'copilot', ownerId: 'gateway-copilot', sessionId: 'global' },
  ];
  for (const key of keys) assert.equal(canReadResourceKey(runtime, state, key), true);
  assert.deepEqual(methods, [
    'gateway.status',
    'pr.list',
    'pr.list',
    'config.githubAccounts',
    'pr.status',
    'pr.forSlot',
    'pr.reviewComments',
    'runner.modelCatalog',
    'providerAccounts.snapshot',
    'providerAccounts.snapshot',
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
  for (const key of [
    { family: 'upstream', integration: 'providers', queryId: 'pr.list:{}' },
    { family: 'upstream', integration: 'providers', queryId: 'pr.status:{"pr":7}' },
    { family: 'upstream', integration: 'github', queryId: 'pr.statusExtra:{}' },
    {
      family: 'upstream',
      integration: 'github',
      queryId: 'config.githubAccounts:{"refresh":true}',
    },
    { family: 'upstream', integration: 'github', queryId: 'gateway.status:{}' },
    // Provider observations are never GitHub observations, and the reverse.
    { family: 'upstream', integration: 'github', queryId: 'providerAccounts.snapshot:{}' },
    { family: 'upstream', integration: 'providers', queryId: 'config.githubAccounts:{}' },
    {
      family: 'upstream',
      integration: 'github',
      queryId: 'runner.modelCatalog:{"runner":"cursor"}',
    },
  ] as const)
    assert.equal(canReadResourceKey(runtime, state, key), false);
  assert.equal(methods.length, before);
  allow = false;
  for (const key of keys) assert.equal(canReadResourceKey(runtime, state, key), false);
});

test('visible-model owner keys reach only that principal, with or without native identity', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'visible-model-key-authorization-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
  allow = true;
  methods.length = 0;
  assert.equal(
    canReadVisibleModelPreferenceKey(runtime, state, {
      family: 'profiles',
      scope: 'owner',
      ownerId: 'reader',
    }),
    true,
  );
  assert.equal(
    canReadVisibleModelPreferenceKey(runtime, state, {
      family: 'profiles',
      scope: 'owner',
      ownerId: 'foreign',
    }),
    false,
  );
  assert.deepEqual(methods, ['runner.visibleModels.get', 'runner.visibleModels.get']);
  for (const key of [
    { family: 'profiles', nodeId: 'local', ownerId: 'reader' },
    { family: 'native-session', scope: 'owner', ownerId: 'reader' },
  ] as const)
    assert.equal(canReadVisibleModelPreferenceKey(runtime, state, key), false);
  assert.equal(methods.length, 2);
  allow = false;
  assert.equal(
    canReadVisibleModelPreferenceKey(runtime, state, {
      family: 'profiles',
      scope: 'owner',
      ownerId: 'reader',
    }),
    false,
  );
});
