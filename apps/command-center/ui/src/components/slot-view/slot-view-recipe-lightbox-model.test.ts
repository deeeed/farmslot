import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearedSlotViewRecipeLightboxScopeIndex,
  scopedSlotViewRecipeArtifacts,
  slotViewRecipeLightboxItems,
  slotViewRecipeLightboxPairs,
} from './slot-view-recipe-lightbox-model.js';

const artifacts = [
  { path: 'artifacts/ac1-before.png', purpose: 'screenshot' },
  { path: 'artifacts/ac1-after.png', purpose: 'screenshot' },
  { path: 'artifacts/notes.md', purpose: 'summary' },
  { path: 'artifacts/trace.json', purpose: 'trace' },
];

test('slot view recipe lightbox model scopes artifacts by selected paths', () => {
  assert.deepEqual(
    scopedSlotViewRecipeArtifacts(artifacts, ['artifacts/ac1-after.png']).map(
      (artifact) => artifact.path,
    ),
    ['artifacts/ac1-after.png'],
  );
  assert.deepEqual(
    scopedSlotViewRecipeArtifacts(artifacts, null).map((artifact) => artifact.path),
    artifacts.map((artifact) => artifact.path),
  );
});

test('slot view recipe lightbox model builds visual and markdown items with kind filtering', () => {
  assert.deepEqual(
    slotViewRecipeLightboxItems({
      artifacts,
      scopePaths: null,
      kindFilter: 'all',
      artifactUrl: (artifact) => `/artifact/${artifact.path}`,
    }).map((item) => item.path),
    ['artifacts/ac1-before.png', 'artifacts/ac1-after.png', 'artifacts/notes.md'],
  );
  assert.deepEqual(
    slotViewRecipeLightboxItems({
      artifacts,
      scopePaths: null,
      kindFilter: 'after',
      artifactUrl: (artifact) => `/artifact/${artifact.path}`,
    }).map((item) => item.path),
    ['artifacts/ac1-after.png'],
  );
});

test('slot view recipe lightbox model builds compare pairs and scope clear index', () => {
  assert.deepEqual(
    slotViewRecipeLightboxPairs({
      artifacts,
      scopePaths: null,
      artifactUrl: (artifact) => `/artifact/${artifact.path}`,
    }),
    [
      {
        before: {
          url: '/artifact/artifacts/ac1-before.png',
          path: 'artifacts/ac1-before.png',
          purpose: 'screenshot',
        },
        after: {
          url: '/artifact/artifacts/ac1-after.png',
          path: 'artifacts/ac1-after.png',
          purpose: 'screenshot',
        },
        stem: 'ac1',
        kind: 'image',
      },
    ],
  );
  assert.equal(clearedSlotViewRecipeLightboxScopeIndex([{ path: 'a' }, { path: 'b' }], 'b'), 1);
  assert.equal(clearedSlotViewRecipeLightboxScopeIndex([{ path: 'a' }], 'b'), null);
});
