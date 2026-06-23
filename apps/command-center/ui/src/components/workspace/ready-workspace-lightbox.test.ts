import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArtifactRef, RecipeRunArtifactGroup } from '@farmslot/protocol';

import {
  readyWorkspaceLightboxItems,
  readyWorkspaceLightboxPairs,
  readyWorkspaceLightboxSourceArtifacts,
  readyWorkspaceOpensInLightbox,
  selectedReadyWorkspaceLightboxRecipeRun,
} from './ready-workspace-lightbox.js';

function artifact(path: string, purpose = 'screenshot'): ArtifactRef {
  return { path, purpose };
}

function recipeRun(id: string, artifactManifest: ArtifactRef[]): RecipeRunArtifactGroup {
  return {
    id,
    label: id,
    groupKind: 'live-run',
    status: 'pass',
    artifactManifest,
  } as RecipeRunArtifactGroup;
}

test('ready workspace lightbox source switches to selected recipe run artifacts', () => {
  const recipeArtifacts = [artifact('artifacts/recipe-after.png')];
  const runs = [recipeRun('live-run:abc', recipeArtifacts)];

  assert.equal(selectedReadyWorkspaceLightboxRecipeRun(runs, 'live-run:abc'), runs[0]);
  assert.deepEqual(
    readyWorkspaceLightboxSourceArtifacts({
      recipeRuns: runs,
      lightboxRecipeRunId: 'live-run:abc',
      allArtifacts: [artifact('artifacts/package-after.png')],
      scopePaths: null,
    }).map((entry) => entry.path),
    ['artifacts/recipe-after.png'],
  );
});

test('ready workspace lightbox source scopes artifacts by path', () => {
  assert.deepEqual(
    readyWorkspaceLightboxSourceArtifacts({
      recipeRuns: [],
      lightboxRecipeRunId: null,
      allArtifacts: [
        artifact('artifacts/before.png'),
        artifact('artifacts/after.png'),
        artifact('artifacts/debug.json', 'json'),
      ],
      scopePaths: ['artifacts/after.png'],
    }).map((entry) => entry.path),
    ['artifacts/after.png'],
  );
});

test('ready workspace lightbox items include media, markdown, and json only', () => {
  const items = readyWorkspaceLightboxItems(
    [
      artifact('artifacts/after.png'),
      artifact('artifacts/report.md', 'markdown'),
      artifact('artifacts/debug.json', 'json'),
      artifact('artifacts/stdout.txt', 'log'),
    ],
    (entry) => `url:${entry.path}`,
  );

  assert.deepEqual(
    items.map((item) => [item.path, item.url]),
    [
      ['artifacts/after.png', 'url:artifacts/after.png'],
      ['artifacts/report.md', 'url:artifacts/report.md'],
      ['artifacts/debug.json', 'url:artifacts/debug.json'],
    ],
  );
  assert.equal(readyWorkspaceOpensInLightbox(artifact('artifacts/stdout.txt')), false);
});

test('ready workspace lightbox pairs keep before/after media compare metadata', () => {
  const pairs = readyWorkspaceLightboxPairs(
    [artifact('artifacts/before-ac1.png'), artifact('artifacts/after-ac1.png')],
    (entry) => `url:${entry.path}`,
  );

  assert.deepEqual(pairs, [
    {
      before: {
        url: 'url:artifacts/before-ac1.png',
        path: 'artifacts/before-ac1.png',
        purpose: 'screenshot',
      },
      after: {
        url: 'url:artifacts/after-ac1.png',
        path: 'artifacts/after-ac1.png',
        purpose: 'screenshot',
      },
      stem: 'ac1',
      kind: 'image',
    },
  ]);
});

test('ready workspace lightbox pairs shared baseline before with AC after captures', () => {
  const pairs = readyWorkspaceLightboxPairs(
    [
      artifact('artifacts/before-autoclose-baseline.png'),
      artifact('artifacts/after-ac1-default-signs.png'),
      artifact('artifacts/after-ac6-negative-tp-trigger.png'),
    ],
    (entry) => `url:${entry.path}`,
  );

  assert.deepEqual(
    pairs.map((pair) => [pair.stem, pair.before.path, pair.after.path]),
    [
      ['ac1', 'artifacts/before-autoclose-baseline.png', 'artifacts/after-ac1-default-signs.png'],
      [
        'ac6',
        'artifacts/before-autoclose-baseline.png',
        'artifacts/after-ac6-negative-tp-trigger.png',
      ],
    ],
  );
});
