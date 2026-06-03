import assert from 'node:assert/strict';
import test from 'node:test';

import { diffArtifactCandidate, diffFocusedFilePathFromRequest } from './diff';

test('diffArtifactCandidate prefers renderable diff text over diff-stat json', () => {
  assert.equal(
    diffArtifactCandidate([
      { path: 'artifacts/diff-stat.json', purpose: 'other' },
      { path: 'artifacts/diff.txt', purpose: 'other' },
    ])?.path,
    'artifacts/diff.txt',
  );
});

test('diffArtifactCandidate ignores diff-stat json when no renderable diff exists', () => {
  assert.equal(
    diffArtifactCandidate([{ path: 'artifacts/diff-stat.json', purpose: 'diff' }]),
    undefined,
  );
  assert.equal(
    diffArtifactCandidate([{ path: 'artifacts/review-diff-summary.json', purpose: 'diff' }]),
    undefined,
  );
});

test('diffFocusedFilePathFromRequest ignores manifest artifact paths and preserves source paths', () => {
  const manifest = [
    { path: 'artifacts/diff-stat.json', purpose: 'other' },
    { path: 'artifacts/diff.txt', purpose: 'other' },
  ];

  assert.equal(diffFocusedFilePathFromRequest('artifacts/diff-stat.json', manifest), '');
  assert.equal(diffFocusedFilePathFromRequest('artifacts/diff.txt', manifest), '');
  assert.equal(
    diffFocusedFilePathFromRequest('app/controllers/perps/HyperLiquidProvider.ts', manifest),
    'app/controllers/perps/HyperLiquidProvider.ts',
  );
});
