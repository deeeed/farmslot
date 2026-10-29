import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryResourceStore,
  runResourceStoreConformance,
} from '../../src/client-cache/index.js';

test(
  'memory store and shared cache obey the portable store conformance contract',
  { timeout: 4000 },
  async () => {
    const checks = await runResourceStoreConformance(createMemoryResourceStore);
    assert.equal(checks.length, 22);
  },
);
