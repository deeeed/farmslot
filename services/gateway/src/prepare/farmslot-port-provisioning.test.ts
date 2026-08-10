import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNoOperatorCollision,
  operatorPortsFromEnv,
  renderEnvPorts,
  resolveSandboxPorts,
} from './farmslot-port-provisioning.js';

// Pool shapes from the real machines (pool/macwork.json, pool/mini.json).
const MACWORK_FF_1 = { port: '8808', metro_port: '8878', cdp_port: '9328', vite_port: '5875' };
const MINI_FF_1 = { port: '8801', metro_port: '8871', cdp_port: '9321', vite_port: '5871' };

test('AC1: mini and macwork slots resolve distinct ports from pool state alone', () => {
  const macwork = resolveSandboxPorts(MACWORK_FF_1, 'macwork-ff-1');
  const mini = resolveSandboxPorts(MINI_FF_1, 'mini-ff-1');
  assert.deepEqual(macwork, { gatewayPort: 8808, vitePort: 5875 });
  assert.deepEqual(mini, { gatewayPort: 8801, vitePort: 5871 });
  // Distinct pairs across machines and within each pair.
  assert.notEqual(macwork!.gatewayPort, mini!.gatewayPort);
  assert.notEqual(macwork!.vitePort, mini!.vitePort);
});

test('slots without vite_port are not opted in', () => {
  assert.equal(resolveSandboxPorts({ port: '8802' }, 'mini-ff-2'), null);
  assert.equal(resolveSandboxPorts({}, 'mini-ff-2'), null);
});

test('a half-configured slot fails loudly instead of falling back', () => {
  assert.throws(
    () => resolveSandboxPorts({ vite_port: '5875' }, 's1'),
    /resources\.dev-server\.port must be a port number/,
  );
  assert.throws(
    () => resolveSandboxPorts({ vite_port: 'abc', port: '8808' }, 's1'),
    /vite_port must be a port number/,
  );
  assert.throws(
    () => resolveSandboxPorts({ vite_port: '8808', port: '8808' }, 's1'),
    /cannot share a port/,
  );
});

test('AC2: operator port reuse is refused before the dev stack starts', () => {
  const operator = { gatewayPort: 7801, vitePort: 5175 };
  assert.throws(
    () => assertNoOperatorCollision({ gatewayPort: 7801, vitePort: 5875 }, operator, 's1'),
    /gateway port 7801 collides with the operator gateway port/,
  );
  assert.throws(
    () => assertNoOperatorCollision({ gatewayPort: 8808, vitePort: 5175 }, operator, 's1'),
    /vite port 5175 collides with the operator UI port/,
  );
  // Disjoint ports pass; an operator env without ports skips the check.
  assertNoOperatorCollision({ gatewayPort: 8808, vitePort: 5875 }, operator, 's1');
  assertNoOperatorCollision({ gatewayPort: 7801, vitePort: 5175 }, {}, 's1');
});

test('operatorPortsFromEnv reads only valid numeric ports', () => {
  assert.deepEqual(operatorPortsFromEnv({ GATEWAY_PORT: '7801', VITE_PORT: '5175' }), {
    gatewayPort: 7801,
    vitePort: 5175,
  });
  assert.deepEqual(operatorPortsFromEnv({ GATEWAY_PORT: 'x' }), {
    gatewayPort: undefined,
    vitePort: undefined,
  });
});

test('renderEnvPorts creates a fresh file with a slot-owner header', () => {
  const content = renderEnvPorts(null, { gatewayPort: 8802, vitePort: 5872 }, 'mini-ff-2');
  assert.equal(
    content,
    '# mini-ff-2 sandbox ports — provisioned from the pool by farmslot prepare\nGATEWAY_PORT=8802\nVITE_PORT=5872\n',
  );
});

test('renderEnvPorts overwrites the port lines and keeps everything else', () => {
  // Real shape from mini-ff-3: hand comment + extra METRO_PORT line.
  const existing =
    '# mini-ff-3 sandbox — isolated from operator Command Center\nGATEWAY_PORT=9999\nVITE_PORT=1111\nMETRO_PORT=8873\n';
  const content = renderEnvPorts(existing, { gatewayPort: 8803, vitePort: 5873 }, 'mini-ff-3');
  assert.equal(
    content,
    '# mini-ff-3 sandbox — isolated from operator Command Center\nMETRO_PORT=8873\nGATEWAY_PORT=8803\nVITE_PORT=5873\n',
  );
});

test('renderEnvPorts normalizes CRLF and trailing blank lines', () => {
  const content = renderEnvPorts(
    'GATEWAY_PORT=1\r\nVITE_PORT=2\r\n\r\n',
    { gatewayPort: 8808, vitePort: 5875 },
    'macwork-ff-1',
  );
  assert.equal(content, 'GATEWAY_PORT=8808\nVITE_PORT=5875\n');
});
