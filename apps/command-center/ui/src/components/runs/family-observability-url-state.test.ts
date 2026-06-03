import assert from 'node:assert/strict';
import test from 'node:test';

import {
  diffSelectionFromFamilyHash,
  familyDiffModalHash,
  familyRunHash,
  slotHistoryHashForRun,
} from './family-observability-url-state.js';

test('familyRunHash preserves route shape and encodes run id', () => {
  assert.equal(familyRunHash('family-1', 'run id/1'), '#family/family-1?run=run+id%2F1');
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
