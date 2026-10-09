import assert from 'node:assert/strict';
import test from 'node:test';

import {
  artifactSelectionFromRunDetailHash,
  isRunDetailHashForRun,
  runDetailEvidenceArtifactHash,
  runDetailStepHash,
  runInventoryHashFromDetail,
  selectedStepNameFromRunDetailHash,
  standaloneRunDetailHash,
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
    artifactView: null,
    artifactAc: null,
  });
});

test('an acceptance evidence link carries its criterion, and closing or a plain artifact drops it', () => {
  const opened = runDetailEvidenceArtifactHash(
    'run-1',
    { path: 'artifacts/evidence-ac1.png' },
    '#run/run-1',
    'AC-1',
  );
  assert.equal(
    opened,
    '#run/run-1?artifactRun=run-1&artifact=artifacts%2Fevidence-ac1.png&artifactAc=AC-1',
  );
  assert.equal(artifactSelectionFromRunDetailHash(opened).artifactAc, 'AC-1');
  assert.equal(
    runDetailEvidenceArtifactHash('run-1', { path: 'final.png' }, opened).includes('artifactAc'),
    false,
  );
  assert.equal(runDetailEvidenceArtifactHash('run-1', null, opened), '#run/run-1');
  assert.equal(runInventoryHashFromDetail(opened).includes('artifactAc'), false);
});

test('run detail recognizes its embedded runs-inventory route', () => {
  assert.equal(isRunDetailHashForRun('run-1', '#runs?run=run-1&runsTab=history'), true);
  assert.equal(isRunDetailHashForRun('run-2', '#runs?run=run-1&runsTab=history'), false);
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

test('changing artifacts removes the previous recording marker selection', () => {
  const next = runDetailEvidenceArtifactHash(
    'run-1',
    { path: 'second.mp4' },
    '#run/run-1?artifact=first.mp4&artifactTrace=7&artifactPhase=end',
  );
  assert.ok(!next.includes('artifactTrace') && !next.includes('artifactPhase'));
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

test('embedded run detail updates keep the runs inventory route and filters', () => {
  const hash = '#runs?projects=farmslot-farm&runsTab=all&run=run-1';

  assert.equal(
    runDetailStepHash('run-1', 'ci-pass', hash),
    '#runs?projects=farmslot-farm&runsTab=all&run=run-1&step=ci-pass',
  );
  assert.equal(
    runDetailEvidenceArtifactHash('run-1', { path: 'captures/after.png' }, hash),
    '#runs?projects=farmslot-farm&runsTab=all&run=run-1&artifactRun=run-1&artifact=captures%2Fafter.png',
  );
});

test('standalone run detail drops a stale inventory selection param', () => {
  assert.equal(
    runDetailStepHash('run-1', 'monitor', '#run/run-1?run=old&projects=farmslot-farm'),
    '#run/run-1?projects=farmslot-farm&step=monitor',
  );
});

test('full-view navigation preserves filters and selected detail state', () => {
  assert.equal(
    standaloneRunDetailHash(
      'run-1',
      '#runs?projects=farmslot-farm&runsTab=all&run=run-1&tab=pr-preview&step=ci-pass',
    ),
    '#run/run-1?projects=farmslot-farm&runsTab=all&tab=pr-preview&step=ci-pass',
  );
});

test('back to inventory preserves its filters and removes detail-only state', () => {
  assert.equal(
    runInventoryHashFromDetail(
      '#run/run-1?projects=farmslot-farm&runsTab=history&status=done&tab=pr-preview&file=report.md&step=ci-pass',
    ),
    '#runs?projects=farmslot-farm&runsTab=history&status=done',
  );
});

test('the step inspector marks the artifacts it owns, and run detail links drop the mark', () => {
  const stepOwned =
    '#run/run-1?step=write-task&artifactRun=run-1&artifact=TASK.md&artifactView=step';
  assert.equal(artifactSelectionFromRunDetailHash(stepOwned).artifactView, 'step');
  // An operation-log link built from that page belongs to run detail's viewer.
  const next = runDetailEvidenceArtifactHash(
    'run-1',
    { path: 'artifacts/operations/a.log' },
    stepOwned,
  );
  assert.equal(artifactSelectionFromRunDetailHash(next).artifactView, null);
  assert.equal(artifactSelectionFromRunDetailHash(next).artifact, 'artifacts/operations/a.log');
});

test('leaving run detail drops the step inspector artifact marker too', () => {
  const next = runInventoryHashFromDetail(
    '#run/run-1?step=write-task&artifactRun=run-1&artifact=TASK.md&artifactView=step',
  );
  assert.doesNotMatch(next, /artifactView|artifact=/);
});

test('choosing another step closes the file the last step had open; history entries keep theirs', () => {
  const taskOpen =
    '#run/run-1?step=write-task&artifactRun=run-1&artifact=TASK.md&artifactView=step';
  const toMonitor = runDetailStepHash('run-1', 'monitor', taskOpen);
  assert.equal(selectedStepNameFromRunDetailHash(toMonitor), 'monitor');
  assert.equal(artifactSelectionFromRunDetailHash(toMonitor).artifact, null);
  assert.equal(artifactSelectionFromRunDetailHash(toMonitor).artifactView, null);
  // Same step (a URL reached by back/forward re-syncing): the file stays.
  assert.equal(runDetailStepHash('run-1', 'write-task', taskOpen), taskOpen);
  // A run-detail artifact is not the step's to drop.
  const runOwned = '#run/run-1?step=write-task&artifactRun=run-1&artifact=artifacts%2Fa.log';
  assert.match(runDetailStepHash('run-1', 'monitor', runOwned), /artifact=artifacts%2Fa\.log/);
});
