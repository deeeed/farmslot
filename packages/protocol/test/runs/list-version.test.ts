import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { canonicalResourceJson } from '../../src/client-cache/keys.js';
import { trimRunForList } from '../../src/runs/list-trim.js';
import { runListVersion } from '../../src/runs/list-version.js';
import { storedRun } from '../fixtures/run.js';

test('the portable list version matches the original gateway hash byte for byte', () => {
  const rows = [
    storedRun('plain'),
    storedRun('unicode', { summary: 'é / 離線 / →', tags: ['saved', 'review'] }),
  ];
  for (const run of rows) {
    const row = trimRunForList(run);
    const original = createHash('sha256').update(canonicalResourceJson(row)).digest('hex');
    assert.equal(runListVersion(row), original);
    assert.equal(
      runListVersion({ ...row, updatedAt: '2026-11-02T00:00:00.000Z' }) === original,
      false,
    );
  }
});
