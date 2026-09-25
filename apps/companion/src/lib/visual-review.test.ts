import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { VisualReviewSourceDocument } from '@farmslot/protocol';

import {
  addVisualReviewAnnotation,
  emptyVisualReviewDraft,
  findVisualReviewSourceArtifacts,
  visualReviewImageArtifactPath,
  visualReviewSurfaceLinks,
} from './visual-review';

const source: VisualReviewSourceDocument = {
  version: 1,
  kind: 'visual-review-source',
  id: 'farmslot-farm:ready-gate',
  title: 'Ready Gate',
  capturedAt: '2026-09-25T00:00:00.000Z',
  surfaces: [
    { id: 'run', title: 'Run', captures: [] },
    { id: 'gate', title: 'Gate', parentId: 'run', captures: [] },
    {
      id: 'evidence',
      title: 'Evidence',
      parentId: 'gate',
      relatedSurfaceIds: ['diff'],
      captures: [],
    },
    { id: 'diff', title: 'Diff', parentId: 'gate', captures: [] },
  ],
  navigationEdges: [{ fromSurfaceId: 'gate', toSurfaceId: 'evidence', kind: 'tab' }],
};

test('finds visual review sources by file name across artifact groups', () => {
  assert.deepEqual(
    findVisualReviewSourceArtifacts([
      { path: 'artifacts/visual-review-source.json.bak', purpose: 'other' },
      { path: 'artifacts/catalog/visual-review-source.json', purpose: 'json' },
    ]).map(({ path }) => path),
    ['artifacts/catalog/visual-review-source.json'],
  );
});

test('resolves capture images relative to the source document', () => {
  assert.equal(
    visualReviewImageArtifactPath('artifacts/catalog/visual-review-source.json', 'ios/./gate.png'),
    'artifacts/catalog/ios/gate.png',
  );
  assert.equal(
    visualReviewImageArtifactPath('artifacts/catalog/visual-review-source.json', '../shared.png'),
    'artifacts/shared.png',
  );
  assert.throws(
    () => visualReviewImageArtifactPath('visual-review-source.json', '../outside.png'),
    /escapes the source directory/u,
  );
});

test('surface links expose ancestors, children, related screens, and incoming edges', () => {
  const links = visualReviewSurfaceLinks(source, 'evidence');
  assert.deepEqual(
    links.ancestors.map(({ id }) => id),
    ['run', 'gate'],
  );
  assert.deepEqual(
    visualReviewSurfaceLinks(source, 'gate').children.map(({ id }) => id),
    ['evidence', 'diff'],
  );
  assert.deepEqual(
    links.related.map(({ id }) => id),
    ['diff'],
  );
  assert.deepEqual(
    links.incoming.map(({ from, kind }) => [from.id, kind]),
    [['gate', 'tab']],
  );
});

test('areas are clipped to the image and accidental slivers are ignored', () => {
  const target = { surfaceId: 'gate', captureId: 'ios' };
  const { annotation } = addVisualReviewAnnotation(emptyVisualReviewDraft(), target, {
    shape: 'area',
    x: 0.8,
    y: -0.2,
    width: 0.5,
    height: 0.4,
  });
  assert.deepEqual(annotation && { x: annotation.x, y: annotation.y }, { x: 0.8, y: 0 });
  assert.ok(annotation?.shape === 'area' && Math.abs(annotation.width - 0.2) < 1e-9);
  const sliver = addVisualReviewAnnotation(emptyVisualReviewDraft(), target, {
    shape: 'area',
    x: 0.1,
    y: 0.1,
    width: 0.005,
    height: 0.3,
  });
  assert.equal(sliver.annotation, undefined);
  assert.equal(sliver.draft.annotations.length, 0);
});
