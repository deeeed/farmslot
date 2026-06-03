import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewSeverityColor, reviewSeverityCounts } from './review-workspace-shell-renderers.js';

test('reviewSeverityCounts preserves severity buckets for top bar badges', () => {
  assert.deepEqual(
    reviewSeverityCounts([
      { severity: 'must_fix' },
      { severity: 'suggestion' },
      { severity: 'must_fix' },
      { severity: 'nitpick' },
    ]),
    { must_fix: 2, suggestion: 1, nitpick: 1 },
  );
});

test('reviewSeverityColor falls back for unknown severities', () => {
  assert.equal(reviewSeverityColor('must_fix'), '#ef4444');
  assert.equal(reviewSeverityColor('custom'), '#6b7280');
});
