import assert from 'node:assert/strict';
import test from 'node:test';

import { type GatewayAuthConnectResult, Methods } from '@farmslot/protocol';

import {
  canOpenNativeConversation,
  workspaceAccessFromAuth,
  workspaceAllowsMethod,
  workspaceHome,
} from './workspace-access';

function auth(access?: 'farm' | 'native' | 'none', admin = false): GatewayAuthConnectResult {
  return {
    ok: true,
    clientKind: 'companion',
    authMode: 'token',
    authenticatedAt: 1,
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      workspaceAccess: access,
    },
    principal: {
      id: 'owner-a',
      displayName: 'Owner',
      subjectKind: 'person',
      roles: admin ? [{ role: 'admin', scope: { kind: 'global' } }] : [],
    },
  };
}

test('server access wins, while older role-free identities fail closed', () => {
  assert.equal(workspaceAccessFromAuth(auth('native')), 'native');
  assert.equal(workspaceAccessFromAuth(auth('none', true)), 'none');
  assert.equal(workspaceAccessFromAuth(auth(undefined)), 'none');
  assert.equal(workspaceAccessFromAuth(auth(undefined, true)), 'farm');
  const legacy = auth();
  delete legacy.principal;
  assert.equal(workspaceAccessFromAuth(legacy), 'farm');
});

test('native accounts allow standalone native methods and reject farm, worker and unknown RPCs', () => {
  for (const method of [
    Methods.NATIVE_SESSION_CREATE,
    Methods.NATIVE_SESSION_READ,
    Methods.NATIVE_SESSION_WORKSPACE_DIFF,
    Methods.GATEWAY_PING,
  ]) {
    assert.equal(workspaceAllowsMethod('native', method, {}), true);
  }
  for (const method of [
    Methods.FLEET_STATUS,
    Methods.RUN_GET,
    Methods.DECISION_LIST,
    'terminal.subscribe',
    'chat.history',
    'native.unknown',
  ]) {
    assert.equal(workspaceAllowsMethod('native', method, {}), false, method);
    assert.equal(workspaceAllowsMethod('farm', method, {}), true, method);
  }
  assert.equal(
    workspaceAllowsMethod('native', Methods.NATIVE_SESSION_READ, { worker: { runId: 'run' } }),
    false,
  );
  assert.equal(workspaceAllowsMethod('none', Methods.NATIVE_SESSION_LIST), false);
  assert.equal(workspaceAllowsMethod('none', Methods.GATEWAY_PING), true);
});

test('native owners cannot open a worker route and unassigned users land on Settings pairing', () => {
  assert.equal(canOpenNativeConversation('native'), true);
  assert.equal(canOpenNativeConversation('native', 'worker-run'), false);
  assert.equal(canOpenNativeConversation('farm', 'worker-run'), true);
  assert.equal(canOpenNativeConversation('none'), false);
  assert.equal(workspaceHome('native'), '/native');
  assert.equal(workspaceHome('farm'), '/(tabs)/runs');
  assert.equal(workspaceHome('none'), '/(tabs)/settings');
});
