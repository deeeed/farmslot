import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyFailureText, KNOWN_REAL_BUG_NEGATIVE_CORPUS } from './failure-patterns.js';
test('classifier maps recoverable failure strings to expected categories', () => {
  assert.equal(classifyFailureText('Vite dev server crashed ECONNREFUSED')?.category, 'infra');
  assert.equal(classifyFailureText('Operation timed out after 30000ms')?.category, 'timeout');
  assert.equal(
    classifyFailureText('fixtures mismatch: AGENTS.md not uptodate')?.category,
    'env-drift',
  );
  assert.equal(classifyFailureText('detox flak intermittent race condition')?.category, 'flake');
});
test('known real bug corpus has zero deterministic matches', () => {
  for (const sample of KNOWN_REAL_BUG_NEGATIVE_CORPUS)
    assert.equal(classifyFailureText(sample), null, sample);
});
test('disabled pattern returns low confidence for watcher guard handling', () => {
  const match = classifyFailureText('fixtures mismatch', ['fixture-env-drift']);
  assert.equal(match?.patternId, 'fixture-env-drift');
  assert.equal(match?.confidence, 'low');
});
