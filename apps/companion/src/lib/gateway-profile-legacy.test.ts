import assert from 'node:assert/strict';
import test from 'node:test';

import { isLegacyPresetGatewayProfile, isLegacyPresetGatewayUrl } from './gateway-profile-legacy';

test('legacy preset cleanup only filters old baked-in profile ids', () => {
  assert.equal(isLegacyPresetGatewayProfile({ id: 'macwork-lan' }), true);
  assert.equal(isLegacyPresetGatewayProfile({ id: 'farmslot-remote' }), true);
  assert.equal(isLegacyPresetGatewayProfile({ id: 'paired-ws-runner-local-local-7777-ws' }), false);
});

test('runner-local LAN URL remains valid for newly paired profiles', () => {
  assert.equal(isLegacyPresetGatewayUrl('ws://runner-local.local:7777/ws'), false);
});
