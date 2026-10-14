import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMaintenanceBranch } from './branch-update.js';

test('normalizes only equivalent explicit remote branch names', () => {
  assert.equal(normalizeMaintenanceBranch('refs/remotes/origin/feat/base'), 'feat/base');
  assert.equal(normalizeMaintenanceBranch('refs/heads/feat/base'), 'feat/base');
  assert.equal(normalizeMaintenanceBranch('origin/feat/base'), 'feat/base');
  assert.equal(normalizeMaintenanceBranch('feature/origin/base'), 'feature/origin/base');
  assert.equal(normalizeMaintenanceBranch('refs/heads/origin/feat'), 'origin/feat');
  assert.equal(normalizeMaintenanceBranch('refs/remotes/origin/origin/feat'), 'origin/feat');
});
