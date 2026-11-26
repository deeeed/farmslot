import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Methods,
  OWNED_WORKER_IDLE_WAIT_MS,
  RUN_REFRESH_PUBLISH_PACKAGE_TIMEOUT_MS,
} from '@farmslot/protocol';

import { resolveRpcGatewayTimeoutMs } from './rpc.js';

test('raw RPC preserves the configured timeout for ordinary calls', () => {
  assert.equal(resolveRpcGatewayTimeoutMs('run.get', {}, '30000'), undefined);
  assert.equal(
    resolveRpcGatewayTimeoutMs(Methods.RESOURCE_CONTROL, { action: 'shutdown' }, '30000'),
    undefined,
  );
});

test('a package refresh outlasts the gateway wait for a busy worker', () => {
  const timeout = resolveRpcGatewayTimeoutMs(Methods.RUN_REFRESH_PUBLISH_PACKAGE, {}, '30000');
  assert.ok(timeout !== undefined && timeout > OWNED_WORKER_IDLE_WAIT_MS);
  assert.equal(timeout, RUN_REFRESH_PUBLISH_PACKAGE_TIMEOUT_MS);
  assert.equal(
    resolveRpcGatewayTimeoutMs(Methods.RUN_REFRESH_PUBLISH_PACKAGE, {}, String(2 * 60 * 60_000)),
    2 * 60 * 60_000,
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
