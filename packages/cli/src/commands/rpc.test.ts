import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods } from '@farmslot/protocol';

import { resolveRpcGatewayTimeoutMs } from './rpc.js';

test('raw RPC preserves the configured timeout for ordinary calls', () => {
  assert.equal(resolveRpcGatewayTimeoutMs('run.get', {}, '30000'), undefined);
  assert.equal(
    resolveRpcGatewayTimeoutMs(Methods.RESOURCE_CONTROL, { action: 'shutdown' }, '30000'),
    undefined,
  );
});

test('raw RPC leaves time for simulator boot and dependent capability acquisition', () => {
  assert.equal(
    resolveRpcGatewayTimeoutMs(Methods.RESOURCE_CONTROL, { action: 'boot' }, '30000'),
    150_000,
  );
  assert.equal(
    resolveRpcGatewayTimeoutMs(Methods.RUNTIME_CAPABILITY_ACQUIRE, {}, '30000'),
    420_000,
  );
  assert.equal(
    resolveRpcGatewayTimeoutMs(Methods.RUNTIME_CAPABILITY_ACQUIRE, {}, '360000'),
    420_000,
  );
  assert.equal(
    resolveRpcGatewayTimeoutMs(Methods.RUNTIME_CAPABILITY_ACQUIRE, {}, '480000'),
    480_000,
  );
});
