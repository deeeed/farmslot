import assert from 'node:assert/strict';
import test from 'node:test';

import { canLaunchComparisonSibling } from './run-selector-model.js';

test('canLaunchComparisonSibling allows terminal, blocked, and human-gating runs', () => {
  assert.equal(canLaunchComparisonSibling('done'), true);
  assert.equal(canLaunchComparisonSibling('failed'), true);
  assert.equal(canLaunchComparisonSibling('cancelled'), true);
  assert.equal(canLaunchComparisonSibling('blocked'), true);
  assert.equal(canLaunchComparisonSibling('human-gating'), true);
  assert.equal(canLaunchComparisonSibling('monitoring'), false);
});
