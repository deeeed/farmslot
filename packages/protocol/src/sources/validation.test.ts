import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertSourceConfiguration, assertSourceEntry, canonicalSourceRepo } from './validation.js';

test('source declarations reject credential URLs, local snapshots, unknown schema and escaping bindings', () => {
  for (const value of [
    'file:///tmp/source',
    '/tmp/source',
    'https://token@example.test/owner/repo',
    'https://example.test/owner/repo?token=secret',
  ])
    assert.throws(() => canonicalSourceRepo(value));
  assert.equal(
    canonicalSourceRepo('git@example.test:owner/repo.git'),
    'ssh://git@example.test/owner/repo',
  );
  for (const entry of ['../helpers', '/helpers', 'a/../b', 'a//b'])
    assert.throws(() => assertSourceEntry({ sourceId: 'demo', entry }));
  assert.throws(() => assertSourceEntry({ entry: '.' }));
  assert.throws(() =>
    assertSourceConfiguration({
      schemaVersion: 2,
      revision: 1,
      pollIntervalMs: 1000,
      sources: [],
      packs: {},
    }),
  );
});
