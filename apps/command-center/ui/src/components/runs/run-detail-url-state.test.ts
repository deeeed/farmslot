import assert from 'node:assert/strict';
import test from 'node:test';

import {
  artifactSelectionFromRunDetailHash,
  isRunDetailHashForRun,
  runDetailEvidenceArtifactHash,
  runDetailStepHash,
  selectedStepNameFromRunDetailHash,
} from './run-detail-url-state.js';

test('run detail helpers read selected step and artifact modal state', () => {
  const hash =
    '#run/run-1?step=publication-review-1&artifactRun=run-1&artifact=captures%2Fafter.png';

  assert.equal(isRunDetailHashForRun('run-1', hash), true);
  assert.equal(isRunDetailHashForRun('run-2', hash), false);
  assert.equal(selectedStepNameFromRunDetailHash(hash), 'publication-review-1');
  assert.deepEqual(artifactSelectionFromRunDetailHash(hash), {
    artifactRun: 'run-1',
    artifact: 'captures/after.png',
  });
});

test('step hash updates preserve unrelated params and evidence modal params', () => {
  const hash = '#run/run-1?view=summary&artifactRun=run-1&artifact=captures%2Fafter.png';

  assert.equal(
    runDetailStepHash('run-1', 'package-refresh', hash),
    '#run/run-1?view=summary&artifactRun=run-1&artifact=captures%2Fafter.png&step=package-refresh',
  );
  assert.equal(
    runDetailStepHash('run-1', null, '#run/run-1?view=summary&step=old&artifact=keep.md'),
    '#run/run-1?view=summary&artifact=keep.md',
  );
});

test('artifact modal hash updates preserve step and unrelated params', () => {
  const hash = '#run/run-1?view=summary&step=review+with+spaces&artifactRun=old&artifact=old.png';

  assert.equal(
    runDetailEvidenceArtifactHash('run-1', { path: 'captures/after image.png' }, hash),
    '#run/run-1?view=summary&step=review+with+spaces&artifactRun=run-1&artifact=captures%2Fafter+image.png',
  );
  assert.equal(
    runDetailEvidenceArtifactHash('run-1', null, hash),
    '#run/run-1?view=summary&step=review+with+spaces',
  );
});
