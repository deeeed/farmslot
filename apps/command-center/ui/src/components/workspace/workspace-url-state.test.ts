import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseReadyWorkspaceHashState,
  parseReviewWorkspaceHashState,
  readyWorkspaceHashWithState,
  reviewWorkspaceHashWithState,
} from './workspace-url-state.js';

test('ready workspace parser constrains typed view params', () => {
  assert.deepEqual(
    parseReadyWorkspaceHashState(
      '#slot/demo?tab=input&file=src%2Findex.ts&modal=lightbox&lightboxIndex=2&lightboxRecipeRunId=live-run%3Aabc',
    ),
    {
      tab: 'input',
      file: 'src/index.ts',
      modal: 'lightbox',
      diffArtifact: undefined,
      lightboxIndex: 2,
      lightboxRecipeRunId: 'live-run:abc',
    },
  );

  assert.deepEqual(
    parseReadyWorkspaceHashState('#slot/demo?tab=bad&modal=unknown&lightboxIndex=-1'),
    {
      tab: undefined,
      file: undefined,
      modal: undefined,
      diffArtifact: undefined,
      lightboxIndex: undefined,
      lightboxRecipeRunId: undefined,
    },
  );
});

test('ready workspace parser accepts slot-view recipeRun as lightbox recipe-run fallback', () => {
  assert.deepEqual(
    parseReadyWorkspaceHashState(
      '#slot/demo?tab=evidence&modal=lightbox&lightboxIndex=2&recipeRun=current-artifacts',
    ),
    {
      tab: 'evidence',
      file: undefined,
      modal: 'lightbox',
      diffArtifact: undefined,
      lightboxIndex: 2,
      lightboxRecipeRunId: 'current-artifacts',
    },
  );

  assert.deepEqual(
    parseReadyWorkspaceHashState(
      '#slot/demo?modal=lightbox&recipeRun=current-artifacts&lightboxRecipeRunId=live-run%3Aabc',
    ).lightboxRecipeRunId,
    'live-run:abc',
  );
});

test('ready workspace writer preserves unrelated params and clears stale modal params', () => {
  assert.equal(
    readyWorkspaceHashWithState(
      { tab: 'diff', file: 'src/index.ts', modal: 'review' },
      '#slot/demo?projects=cc&modal=diff&diffArtifact=old.diff&lightboxIndex=4&lightboxRecipeRunId=live-run%3Aold',
    ),
    '#slot/demo?projects=cc&modal=review&tab=diff&file=src%2Findex.ts',
  );

  assert.equal(
    readyWorkspaceHashWithState(
      { tab: 'evidence', modal: 'lightbox', lightboxIndex: 3, lightboxRecipeRunId: 'live-run:abc' },
      '#slot/demo?projects=cc&file=old.ts&diffArtifact=old.diff',
    ),
    '#slot/demo?projects=cc&tab=evidence&modal=lightbox&lightboxIndex=3&lightboxRecipeRunId=live-run%3Aabc',
  );

  assert.equal(readyWorkspaceHashWithState({ tab: 'diff' }, ''), null);
});

test('review workspace panel state preserves unrelated params', () => {
  assert.deepEqual(
    parseReviewWorkspaceHashState('#slot/demo?panel=evidence,quality,bad&projects=cc'),
    {
      panels: ['evidence', 'quality'],
    },
  );

  assert.equal(
    reviewWorkspaceHashWithState(
      { panels: ['evidence', 'recipe', 'learnings'] },
      '#slot/demo?projects=cc&panel=quality',
    ),
    '#slot/demo?projects=cc&panel=evidence%2Crecipe%2Clearnings',
  );

  assert.equal(
    reviewWorkspaceHashWithState({ panels: [] }, '#slot/demo?projects=cc&panel=quality'),
    '#slot/demo?projects=cc',
  );
});
