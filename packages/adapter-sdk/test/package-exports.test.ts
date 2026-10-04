import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

// A node process without the test runner's loader is a real CommonJS consumer.
test('the package require()s from CommonJS', () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const sdk = require('@farmslot/adapter-sdk');
      if (typeof sdk.createAdapterRegistry !== 'function') throw new Error('createAdapterRegistry is not exported');
      if (typeof sdk.defineAdapter !== 'function') throw new Error('defineAdapter is not exported');
      if (sdk.ADAPTER_SDK_VERSION !== 1) throw new Error('ADAPTER_SDK_VERSION is not 1');`,
    ],
    { cwd: packageRoot, env, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});
