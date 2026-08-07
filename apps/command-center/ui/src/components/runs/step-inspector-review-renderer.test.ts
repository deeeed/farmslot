import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { ReviewLoopAttempt } from './step-inspector-model.js';
import { renderReviewAttempt } from './step-inspector-review-renderer.js';

// Flatten a lit TemplateResult (and nested results/arrays) into its rendered
// text by interleaving the static `strings` with the resolved dynamic `values`.
// `nothing` and other sentinels have neither, so they collapse to ''.
function litText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(litText).join('');
  if (typeof value === 'object' && 'strings' in value && 'values' in value) {
    const { strings, values } = value as { strings: string[]; values: unknown[] };
    return strings.map((s, i) => s + (i < values.length ? litText(values[i]) : '')).join('');
  }
  return '';
}

function attempt(overrides: Partial<ReviewLoopAttempt> = {}): ReviewLoopAttempt {
  return {
    loopNumber: 2,
    verdict: 'pass',
    unresolvedCount: 0,
    issues: [],
    completedAt: '',
    hasFixDelta: false,
    fixDeltaPath: null,
    ...overrides,
  };
}

test('renderReviewAttempt shows a tracked worker fix without requiring a diff artifact', () => {
  const text = litText(renderReviewAttempt(attempt({ hasFixDelta: true, fixDeltaPath: null }), 1));
  assert.match(text, /worker fix applied/);
  assert.doesNotMatch(text, / · /);
});

test('renderReviewAttempt appends the diff path when present', () => {
  const text = litText(
    renderReviewAttempt(
      attempt({ hasFixDelta: true, fixDeltaPath: 'artifacts/review-loop-2/fix-delta.diff' }),
      1,
    ),
  );
  assert.match(text, /worker fix applied · artifacts\/review-loop-2\/fix-delta\.diff/);
});

test('renderReviewAttempt omits the worker-fix line when there is no fixDelta', () => {
  const text = litText(renderReviewAttempt(attempt({ hasFixDelta: false }), 0));
  assert.doesNotMatch(text, /worker fix applied/);
});

test('renderReviewAttempt renders loop number and unresolved count', () => {
  const text = litText(
    renderReviewAttempt(attempt({ loopNumber: 1, verdict: 'issues', unresolvedCount: 8 }), 0),
  );
  assert.match(text, /Review attempt 1/);
  assert.match(text, /8 unresolved/);
});
