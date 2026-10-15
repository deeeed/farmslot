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

test('ready workspace lightbox items include media, documents, and execution logs', () => {
  const items = readyWorkspaceLightboxItems(
    [
      artifact('artifacts/after.png'),
      artifact('artifacts/report.md', 'markdown'),
      artifact('artifacts/debug.json', 'json'),
      artifact('artifacts/stdout.txt', 'log'),
      artifact('artifacts/deterministic-checks/CHECKLIST.md/1.log', 'ci-parity-log'),
    ],
    (entry) => `url:${entry.path}`,
  );

  assert.deepEqual(
    items.map((item) => [item.path, item.url]),
    [
      ['artifacts/after.png', 'url:artifacts/after.png'],
      ['artifacts/report.md', 'url:artifacts/report.md'],
      ['artifacts/debug.json', 'url:artifacts/debug.json'],
      [
        'artifacts/deterministic-checks/CHECKLIST.md/1.log',
        'url:artifacts/deterministic-checks/CHECKLIST.md/1.log',
      ],
    ],
  );
  assert.equal(readyWorkspaceOpensInLightbox(artifact('artifacts/stdout.txt')), false);
});

test('lightbox comparison needs checked bindings rather than AC-like filenames', () => {
  const files = [artifact('artifacts/before-ac1.png'), artifact('artifacts/after-ac1.png')];
  assert.deepEqual(
    readyWorkspaceLightboxPairs(files, (entry) => `url:${entry.path}`),
    [],
  );
  assert.equal(readyWorkspaceLightboxItems(files, (entry) => `url:${entry.path}`).length, 2);
});

test('an unbound shared baseline never borrows every AC after capture', () => {
  const files = [
    artifact('artifacts/before-autoclose-baseline.png'),
    artifact('artifacts/after-ac1-default-signs.png'),
    artifact('artifacts/after-ac6-negative-tp-trigger.png'),
  ];
  assert.deepEqual(
    readyWorkspaceLightboxPairs(files, (entry) => `url:${entry.path}`),
    [],
  );
  assert.equal(readyWorkspaceLightboxItems(files, (entry) => `url:${entry.path}`).length, 3);
});
