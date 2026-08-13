import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getSlotViewHashParam,
  isSlotViewHashForSlot,
  requestedFileFromHash,
  requestedRecipeEvidenceModeFromHash,
  requestedRecipeViewerModeFromHash,
  requestedResourceFromHash,
  requestedReviewDrawerModeFromHash,
  requestedRunFromHash,
  slotViewHash,
} from './slot-view-url-state.js';

test('getSlotViewHashParam reads URL encoded slot-view state', () => {
  const hash = '#slot/demo?file=src%2Findex.ts&resource=ios%20sim&runId=abc123';

  assert.equal(requestedFileFromHash(hash), 'src/index.ts');
  assert.equal(requestedResourceFromHash(hash), 'ios sim');
  assert.equal(requestedRunFromHash(hash), 'abc123');
  assert.equal(getSlotViewHashParam('missing', hash), null);
});

test('recipe viewer modes are constrained to supported values', () => {
  assert.equal(requestedRecipeEvidenceModeFromHash('#slot/demo?recipeEvidenceMode=node'), 'node');
  assert.equal(requestedRecipeEvidenceModeFromHash('#slot/demo?recipeEvidenceMode=bad'), null);
  assert.equal(requestedRecipeViewerModeFromHash('#slot/demo?recipeViewerMode=compare'), 'compare');
  assert.equal(requestedRecipeViewerModeFromHash('#slot/demo?recipeViewerMode=bad'), 'single');
  assert.equal(requestedReviewDrawerModeFromHash('#slot/demo?reviewDrawer=recipe'), 'recipe');
  assert.equal(requestedReviewDrawerModeFromHash('#slot/demo?reviewDrawer=bad'), null);
});

test('slot view hash writer centralizes active view state', () => {
  assert.equal(
    slotViewHash({
      slotId: 'demo',
      activity: 'info',
      runId: 'run-1',
      file: 'src/index.ts',
      resource: 'ios sim',
      recipeNode: 'ac1',
      recipeEvidenceMode: 'node',
      recipeViewerOpen: true,
      recipeViewerMode: 'compare',
      recipeViewerPair: 2,
      reviewDrawerMode: 'recipe',
      historyOpen: true,
      historyRun: 'run-0',
    }),
    '#slot/demo?activity=info&runId=run-1&file=src%2Findex.ts&resource=ios+sim&recipeNode=ac1&recipeEvidenceMode=node&recipeViewer=1&recipeViewerMode=compare&recipeViewerPair=2&reviewDrawer=recipe&history=1&historyRun=run-0',
  );
  assert.equal(isSlotViewHashForSlot('demo', '#slot/demo?file=a'), true);
  assert.equal(isSlotViewHashForSlot('other', '#slot/demo?file=a'), false);
});
