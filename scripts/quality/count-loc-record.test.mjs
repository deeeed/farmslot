import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HISTORY_PATH,
  locSnapshotMetricsMatch,
  shouldCount,
} from './count-loc.mjs';

const baseSnapshot = {
  commit: 'aaa1111',
  scope: 'framework',
  exclusions: { tests: false, dev: false },
  totals: { files: 100, code: 5000, docs: 100, config: 50, total: 5150 },
  rollup: { apps: { code: 1000, total: 1100 }, services: { code: 2000, total: 2100 } },
};

const defaultOptions = {
  scope: 'framework',
  excludeTests: false,
  excludeDev: false,
};

test('locSnapshotMetricsMatch returns true when only commit differs', () => {
  const next = { ...baseSnapshot, commit: 'bbb2222' };
  assert.equal(locSnapshotMetricsMatch(baseSnapshot, next), true);
});

test('locSnapshotMetricsMatch returns false when code totals change', () => {
  const next = {
    ...baseSnapshot,
    commit: 'bbb2222',
    totals: { ...baseSnapshot.totals, code: 5001, total: 5151 },
  };
  assert.equal(locSnapshotMetricsMatch(baseSnapshot, next), false);
});

test('shouldCount skips self-referential loc-history file', () => {
  assert.equal(shouldCount(HISTORY_PATH, defaultOptions), false);
  assert.equal(shouldCount('scripts/quality/count-loc.mjs', defaultOptions), true);
});