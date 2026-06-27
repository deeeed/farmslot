import assert from 'node:assert/strict';
import test from 'node:test';

import { isRunBundleManifest, RUN_BUNDLE_VERSION } from '../../src/contracts/run-bundles.js';

test('isRunBundleManifest accepts a minimal valid manifest', () => {
  assert.equal(
    isRunBundleManifest({
      version: RUN_BUNDLE_VERSION,
      profile: 'reference',
      exportedAt: new Date().toISOString(),
      bundleId: 'bundle-1',
      source: { farmslotRoot: '/tmp/farmslot', runIds: ['run-1'] },
      remapPolicy: 'remap-ids',
      runs: [{ originalRunId: 'run-1', runPath: 'runs/run-1.json' }],
      entries: {
        'runs/run-1.json': { sha256: 'abc', bytes: 1, path: 'runs/run-1.json' },
      },
    }),
    true,
  );
});