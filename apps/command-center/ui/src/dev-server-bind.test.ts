import assert from 'node:assert/strict';
import test from 'node:test';

import { commandCenterDevBind, devGatewayPortDefine } from './dev-server-bind.js';

test('dev server bind stays unset when the env is absent', () => {
  assert.deepEqual(commandCenterDevBind({}), {});
  assert.deepEqual(
    commandCenterDevBind({ FARMSLOT_UI_HOST: '  ', FARMSLOT_UI_ALLOWED_HOSTS: ' , ' }),
    {},
  );
  assert.equal(devGatewayPortDefine({}), '');
  assert.equal(devGatewayPortDefine({ GATEWAY_PORT: 'nope' }), '');
});

test('dev server bind reads host, allowed hosts, and gateway port from env', () => {
  assert.deepEqual(
    commandCenterDevBind({
      FARMSLOT_UI_HOST: ' 0.0.0.0 ',
      FARMSLOT_UI_ALLOWED_HOSTS: ' lan.example, other.example ',
    }),
    { host: '0.0.0.0', allowedHosts: ['lan.example', 'other.example'] },
  );
  assert.equal(devGatewayPortDefine({ GATEWAY_PORT: '7801' }), '7801');
});
