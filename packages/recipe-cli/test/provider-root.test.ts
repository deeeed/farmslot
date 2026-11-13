import assert from 'node:assert/strict';
import { test } from 'node:test';

import { providerEnvironmentRoot } from '../src/harness/provider-root.js';

test('provider root selection reports the authority used by retained fallback', () => {
  const declaration = { module: 'fixture/provider', root: { env: 'FIXTURE_ROOT' } };
  const env = { FIXTURE_ROOT: '/explicit/provider' };
  const poolEnv = { FIXTURE_ROOT: '/pool/provider' };
  assert.deepEqual(providerEnvironmentRoot(declaration, { env, poolEnv }), {
    root: poolEnv.FIXTURE_ROOT,
    source: 'pool',
  });
  assert.deepEqual(
    providerEnvironmentRoot(declaration, {
      env,
      poolEnv,
      authorizedProviders: [declaration.module],
    }),
    { root: env.FIXTURE_ROOT, source: 'authorized-env' },
  );
  assert.equal(providerEnvironmentRoot(declaration, { env }), undefined);
});
