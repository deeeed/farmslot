import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  validateVisualReviewFeedbackDocument,
  validateVisualReviewSourceDocument,
  type VisualReviewSourceDocument,
} from '../../src/index.js';

const source: VisualReviewSourceDocument = {
  version: 1,
  kind: 'visual-review-source',
  id: 'farmslot-farm:ready-gate',
  title: 'Ready Gate review',
  capturedAt: '2026-09-25T00:00:00.000Z',
  runId: 'run-1',
  surfaces: [
    {
      id: 'ready-gate',
      title: 'Ready Gate',
      captures: [{ id: 'ios', platform: 'ios', image: { path: 'ios/gate.png' } }],
    },
    {
      id: 'evidence',
      title: 'Evidence',
      parentId: 'ready-gate',
      relatedSurfaceIds: ['diff'],
      captures: [{ id: 'ios', platform: 'ios', image: { path: 'ios/evidence.png' } }],
    },
    {
      id: 'diff',
      title: 'Diff',
      parentId: 'ready-gate',
      captures: [{ id: 'ios', platform: 'ios', image: { path: 'ios/diff.png' } }],
    },
  ],
  navigationEdges: [{ fromSurfaceId: 'ready-gate', toSurfaceId: 'evidence', kind: 'tab' }],
};

test('visual review source validator accepts hierarchy, related links, and edges', () => {
  const result = validateVisualReviewSourceDocument(source);
  assert.deepEqual(result.errors, []);
  assert.equal(result.document, source);
});

test('visual review source validator rejects missing targets and parent cycles', () => {
  const result = validateVisualReviewSourceDocument({
    ...source,
    surfaces: [
      { ...source.surfaces[0], parentId: 'diff' },
      { ...source.surfaces[1], relatedSurfaceIds: ['missing'] },
      source.surfaces[2],
    ],
    navigationEdges: [{ fromSurfaceId: 'ready-gate', toSurfaceId: 'diff', kind: 'drawer' }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    'source.surfaces[0] parent hierarchy contains a cycle',
    'source.surfaces[1].relatedSurfaceIds references a missing surface',
    'source.surfaces[1] parent hierarchy contains a cycle',
    'source.surfaces[2] parent hierarchy contains a cycle',
    'source.navigationEdges[0].kind must be one of tab, push, in-place, modal, replace',
  ]);
});

test('visual review feedback validator binds notes and annotations to source ids', () => {
  const valid = validateVisualReviewFeedbackDocument({
    version: 1,
    kind: 'visual-review-feedback',
    source,
    surfaceNotes: [{ surfaceId: 'ready-gate', body: 'Tighten the header.' }],
    annotations: [
      {
        id: 'annotation-1',
        surfaceId: 'evidence',
        captureId: 'ios',
        shape: 'point',
        x: 0.4,
        y: 0.2,
        color: '#e84a8a',
        body: 'Label clipped.',
      },
      {
        id: 'annotation-2',
        surfaceId: 'diff',
        captureId: 'ios',
        shape: 'area',
        x: 0.7,
        y: 0.1,
        width: 0.3,
        height: 0.5,
        body: 'Group these rows.',
      },
    ],
  });
  assert.deepEqual(valid.errors, []);

  const invalid = validateVisualReviewFeedbackDocument({
    version: 1,
    kind: 'visual-review-feedback',
    source,
    surfaceNotes: [{ surfaceId: 'timeline', body: 'Unknown surface.' }],
    annotations: [
      {
        id: 'annotation-1',
        surfaceId: 'evidence',
        captureId: 'android',
        shape: 'area',
        x: 0.8,
        y: 0.1,
        width: 0.4,
        height: 0.1,
        color: 'red',
        body: ' ',
      },
    ],
  });
  assert.deepEqual(invalid.errors, [
    'surfaceNotes[0].surfaceId must reference a source surface',
    'annotations[0].body must be a non-empty string',
    'annotations[0] must reference a source surface capture',
    'annotations[0].color must be a #rrggbb hex value',
    'annotations[0] area must have a positive size inside the image',
  ]);
});
