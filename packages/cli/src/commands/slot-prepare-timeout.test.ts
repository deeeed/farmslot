import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSlotPrepareGatewayTimeoutMs } from './slot-prepare-timeout.js';

test('slot prepare keeps the gateway request alive for long native prepares', () => {
  assert.equal(resolveSlotPrepareGatewayTimeoutMs('30000'), 1_805_000);
  assert.equal(resolveSlotPrepareGatewayTimeoutMs(undefined), 1_805_000);
});

test('slot prepare preserves larger explicit gateway timeouts', () => {
  assert.equal(resolveSlotPrepareGatewayTimeoutMs('2000000'), 2_000_000);
});
