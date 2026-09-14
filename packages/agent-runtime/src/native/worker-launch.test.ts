import assert from 'node:assert/strict';
import test from 'node:test';

import { nativeWorkerEnvironment } from './worker-launch.js';

test('worker environments remove inherited and configured control-plane credentials', () => {
  const originalEnvironment = process.env;
  const credentials = {
    FARMSLOT_NODE_TOKEN: 'synthetic-node-token',
    FARMSLOT_GATEWAY_TOKEN: 'synthetic-gateway-token',
    FARMSLOT_GATEWAY_PASSWORD: 'synthetic-gateway-password',
  };
  try {
    // Replace the environment rather than reading any real credential values.
    process.env = { ...credentials, CODEX_LB_API_KEY: 'synthetic-runner-key' };
    for (const set of [{}, credentials]) {
      const env = nativeWorkerEnvironment({
        leaseId: 'fixture-lease',
        safetyTier: 'sandboxed',
        environment: { set, unset: [] },
      });
      for (const name of Object.keys(credentials)) assert.equal(Object.hasOwn(env, name), false);
      assert.equal(env.CODEX_LB_API_KEY, 'synthetic-runner-key');
      assert.equal(env.DISABLE_OMC, '1');
      assert.equal(env.DISABLE_OMX, '1');
    }
    assert.deepEqual(credentials, {
      FARMSLOT_NODE_TOKEN: 'synthetic-node-token',
      FARMSLOT_GATEWAY_TOKEN: 'synthetic-gateway-token',
      FARMSLOT_GATEWAY_PASSWORD: 'synthetic-gateway-password',
    });
  } finally {
    process.env = originalEnvironment;
  }
});
