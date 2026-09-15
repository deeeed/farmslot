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

test('filesystem launch contract rejects overlapping source grants and binds grants into its digest', async () => {
  const {
    decodeNativeWorkerLaunch,
    nativeWorkerLaunchDigest,
    validateNativeWorkerFilesystemPolicy,
  } = await import('./worker-launch.js');
  const launch = {
    leaseId: '10000000-0000-4000-8000-000000000001',
    safetyTier: 'sandboxed',
    environment: { set: {}, unset: [] },
    filesystemPolicy: { readOnlyRoots: ['/repo'], writableRoots: ['/task', '/output'] },
  };
  const decoded = decodeNativeWorkerLaunch(launch);
  assert.deepEqual(decoded.filesystemPolicy, launch.filesystemPolicy);
  assert.notEqual(
    nativeWorkerLaunchDigest(decoded),
    nativeWorkerLaunchDigest({ ...decoded, filesystemPolicy: undefined }),
  );
  assert.notEqual(
    nativeWorkerLaunchDigest(decoded),
    nativeWorkerLaunchDigest({
      ...decoded,
      filesystemPolicy: { ...launch.filesystemPolicy, writableRoots: ['/other'] },
    }),
  );
  for (const writableRoots of [['/'], ['/repo'], ['/repo/output'], ['/repo/../repo']]) {
    assert.throws(
      () => validateNativeWorkerFilesystemPolicy({ ...launch.filesystemPolicy, writableRoots }),
      /overlap/,
    );
  }
  for (const invalid of [
    {},
    { ...launch.filesystemPolicy, writableRoots: ['relative'] },
    { ...launch.filesystemPolicy, writableRoots: [] },
  ])
    assert.throws(() => validateNativeWorkerFilesystemPolicy(invalid), /absolute paths/);
});
