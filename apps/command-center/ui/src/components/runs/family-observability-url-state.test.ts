import assert from 'node:assert/strict';
import test from 'node:test';

import {
  diffSelectionFromFamilyHash,
  evidenceFilterFromFamilyHash,
  familyDiffModalHash,
  familyEvidenceFilterHash,
  familyRunHash,
  familyTokenViewHash,
  slotHistoryHashForRun,
  tokenViewFromFamilyHash,
} from './family-observability-url-state.js';

test('familyRunHash preserves route shape and encodes run id', () => {
  assert.equal(familyRunHash('family-1', 'run id/1'), '#family/family-1?run=run+id%2F1');
  assert.equal(
    familyRunHash('family-1', 'run id/1', { evidence: 'videos' }),
    '#family/family-1?run=run+id%2F1&evidence=videos',
  );
  assert.equal(
    familyRunHash('family-1', 'run-a', { tokens: 'run', trajectory: 'pr-complete-milestones' }),
    '#family/family-1?run=run-a&tokens=run&trajectory=pr-complete-milestones',
  );
});

test('tokenViewFromFamilyHash parses token scope and trajectory', () => {
  assert.deepEqual(
    tokenViewFromFamilyHash('#family/fam-1?run=abc&tokens=run&trajectory=pr-complete-milestones'),
    { scope: 'run', trajectory: 'pr-complete-milestones' },
  );
  assert.deepEqual(tokenViewFromFamilyHash('#family/fam-1?run=abc'), {
    scope: 'family',
    trajectory: 'all-runs',
  });
});

test('familyTokenViewHash updates token params without dropping existing params', () => {
  assert.equal(
    familyTokenViewHash('run', 'pr-complete-milestones', '#family/fam-1?run=abc'),
    '#family/fam-1?run=abc&tokens=run&trajectory=pr-complete-milestones',
  );
  assert.equal(
    familyTokenViewHash(
      'family',
      'all-runs',
      '#family/fam-1?run=abc&tokens=run&trajectory=pr-complete-milestones',
    ),
    '#family/fam-1?run=abc',
  );
});

test('evidenceFilterFromFamilyHash parses supported family evidence filters', () => {
  assert.equal(evidenceFilterFromFamilyHash('#family/fam-1?run=abc&evidence=videos'), 'videos');
  assert.equal(evidenceFilterFromFamilyHash('#family/fam-1?run=abc&evidence=banana'), null);
  assert.equal(evidenceFilterFromFamilyHash('#runs?tab=history'), null);
});

test('familyEvidenceFilterHash updates evidence filter without dropping existing params', () => {
  assert.equal(
    familyEvidenceFilterHash('videos', '#family/fam-1?run=abc&machines=macwork'),
    '#family/fam-1?run=abc&machines=macwork&evidence=videos',
  );
  assert.equal(
    familyEvidenceFilterHash('all', '#family/fam-1?run=abc&evidence=videos'),
    '#family/fam-1?run=abc',
  );
});

test('slotHistoryHashForRun builds slot history navigation from a family run', () => {
  assert.equal(
    slotHistoryHashForRun('runner-a/mobile 1', 'run id/1'),
    '#slot/runner-a/mobile 1?history=1&historyRun=run+id%2F1',
  );
});

test('family diff modal helpers read and update diff params without dropping existing params', () => {
  const hash = '#family/fam-1?run=abc&diffRun=old&diffArtifact=old.diff';

  assert.deepEqual(diffSelectionFromFamilyHash(hash), { runId: 'old', path: 'old.diff' });
  assert.equal(
    familyDiffModalHash({ runId: 'new-run', path: 'artifacts/fix.diff' }, hash),
    '#family/fam-1?run=abc&diffRun=new-run&diffArtifact=artifacts%2Ffix.diff',
  );
  assert.equal(familyDiffModalHash(null, hash), '#family/fam-1?run=abc');
});
