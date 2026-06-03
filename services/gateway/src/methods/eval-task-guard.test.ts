import assert from 'node:assert/strict';
import test from 'node:test';

import { assertArtifactOnlyEvalTaskGuard } from './eval-task-guard.js';

test('artifact-only eval task guard accepts explicit negative no-PR instructions', () => {
  assert.doesNotThrow(() =>
    assertArtifactOnlyEvalTaskGuard(
      [
        'Do not run gh pr create.',
        'Do not run `gh pr create`.',
        'Never run gh pr comment.',
        'Must not git push origin.',
        'Do not open a PR for this artifact-only eval.',
        'Do not perform GitHub PR mutations.',
        'Do not publish output intended for merge.',
        'Open pr-related notes only as local docs.',
      ].join('\n'),
    ),
  );
});

test('artifact-only eval task guard rejects merge-intended instructions', () => {
  assert.throws(
    () => assertArtifactOnlyEvalTaskGuard('Run gh pr create after finishing the eval.'),
    /forbidden GitHub PR creation command/,
  );
  assert.throws(
    () => assertArtifactOnlyEvalTaskGuard('Open a PR and mark ready when done.'),
    /forbidden merge-intended ready instruction|forbidden open-PR instruction/,
  );
  assert.throws(
    () => assertArtifactOnlyEvalTaskGuard('Open a pull request after the artifacts look good.'),
    /forbidden open-PR instruction/,
  );
});

test('artifact-only eval task guard treats negation as clause-scoped', () => {
  assert.throws(
    () =>
      assertArtifactOnlyEvalTaskGuard(
        'Do not skip verification; run gh pr create after it passes.',
      ),
    /forbidden GitHub PR creation command/,
  );
  assert.doesNotThrow(() =>
    assertArtifactOnlyEvalTaskGuard(
      'Do not skip verification; do not run gh pr create after it passes.',
    ),
  );
  assert.doesNotThrow(() =>
    assertArtifactOnlyEvalTaskGuard('You must not allow worker to mark ready.'),
  );
  assert.throws(
    () => assertArtifactOnlyEvalTaskGuard('Never run gh pr create unless reviewers approve.'),
    /forbidden GitHub PR creation command/,
  );
  assert.throws(
    () =>
      assertArtifactOnlyEvalTaskGuard('There is no reason to run gh pr create after the trial.'),
    /forbidden GitHub PR creation command/,
  );
});
