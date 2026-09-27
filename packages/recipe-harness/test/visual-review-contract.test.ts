import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createVisualReviewFeedbackDocument,
  validateVisualReviewFeedbackDocument,
  type VisualReviewSourceDocument,
} from '@farmslot/protocol';

import { feedbackDraftFromDocument, generateReviewBoard } from '../visual-review/index.mjs';

const readyGateSource: VisualReviewSourceDocument = {
  version: 1,
  kind: 'visual-review-source',
  id: 'farmslot-farm:ready-gate',
  title: 'Ready Gate review',
  capturedAt: '2026-09-25T00:00:00.000Z',
  runId: 'run-ready-gate',
  surfaces: [
    {
      id: 'capture-ready-gate',
      title: 'Ready Gate',
      captures: [{ id: 'ios', platform: 'ios', image: { path: 'ios/11_ready_gate_full.png' } }],
    },
    ...(['evidence', 'diff', 'timeline'] as const).map((tab) => ({
      id: `capture-ready-${tab}`,
      title: `Ready Gate — ${tab}`,
      parentId: 'capture-ready-gate',
      captures: [{ id: 'ios', platform: 'ios', image: { path: `ios/${tab}.png` } }],
    })),
  ],
};

test('portable feedback validates and reopens in the HTML board with ids preserved', async () => {
  const document = createVisualReviewFeedbackDocument(readyGateSource, {
    surfaceNotes: {
      'capture-ready-gate': 'Summary reads well.',
      'capture-ready-diff': '   ',
      'capture-retired': 'Surface no longer captured.',
    },
    annotations: [
      {
        id: 'annotation-1',
        surfaceId: 'capture-ready-evidence',
        captureId: 'ios',
        shape: 'point',
        x: 0.25,
        y: 0.4,
        color: '#e84a8a',
        body: 'Badge overlaps the title.',
      },
      {
        id: 'annotation-2',
        surfaceId: 'capture-ready-timeline',
        captureId: 'ios',
        shape: 'area',
        x: 0.1,
        y: 0.2,
        width: 0.5,
        height: 0.3,
        color: '#20b486',
        body: 'Collapse these rows.',
      },
      {
        id: 'annotation-3',
        surfaceId: 'capture-ready-diff',
        captureId: 'ios',
        shape: 'point',
        x: 0.5,
        y: 0.5,
        body: '',
      },
    ],
  });

  const validation = validateVisualReviewFeedbackDocument(document);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(document.surfaceNotes, [
    { surfaceId: 'capture-ready-gate', body: 'Summary reads well.' },
  ]);
  assert.deepEqual(
    document.annotations.map(({ id }) => id),
    ['annotation-1', 'annotation-2'],
  );

  const reopened = feedbackDraftFromDocument(readyGateSource, JSON.parse(JSON.stringify(document)));
  assert.deepEqual(reopened.surfaceNotes, { 'capture-ready-gate': 'Summary reads well.' });
  assert.deepEqual(reopened.annotations, document.annotations);
  assert.deepEqual(createVisualReviewFeedbackDocument(readyGateSource, reopened), document);

  assert.throws(
    () =>
      feedbackDraftFromDocument(readyGateSource, {
        ...document,
        source: { ...readyGateSource, id: 'other-farm:catalog' },
      }),
    /Feedback belongs to source other-farm:catalog/u,
  );
});

test('the generated board embeds the same feedback restore used by the contract', async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'farmslot-visual-review-contract-'));
  try {
    generateReviewBoard({ outputDir, source: readyGateSource, storageKey: 'contract' });
    const client = await readFile(path.join(outputDir, 'assets', 'review-board.js'), 'utf8');
    const screen = await readFile(
      path.join(outputDir, 'screens', 'capture-ready-gate.html'),
      'utf8',
    );
    assert.match(screen, /data-feedback-open/u);
    assert.equal(client.includes(feedbackDraftFromDocument.toString()), true);
    assert.match(client, /feedbackDraftFromDocument\(source, JSON\.parse/u);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('reopening refuses malformed or stale feedback instead of storing part of it', () => {
  const feedback = (annotations: unknown[], extra: Record<string, unknown> = {}) => ({
    version: 1,
    kind: 'visual-review-feedback',
    source: readyGateSource,
    surfaceNotes: [],
    annotations,
    ...extra,
  });
  const point = {
    id: 'c',
    surfaceId: 'capture-ready-diff',
    captureId: 'ios',
    shape: 'point',
    x: 0.3,
    y: 0.3,
    body: 'kept',
  };
  assert.throws(
    () =>
      feedbackDraftFromDocument(
        readyGateSource,
        feedback([point], { surfaceNotes: [{ surfaceId: 'capture-ready-gate' }] }),
      ),
    /invalid entries: surfaceNotes\[0\]\. Nothing was opened/u,
  );
  assert.throws(
    () =>
      feedbackDraftFromDocument(
        readyGateSource,
        feedback([point, { ...point, id: 'd', shape: 'area', width: 0.8, height: 0.1 }]),
      ),
    /invalid entries: annotations\[1\]/u,
  );
  assert.throws(
    () =>
      feedbackDraftFromDocument(
        readyGateSource,
        feedback([point], {
          surfaceNotes: [
            { surfaceId: 'capture-ready-gate', body: 'first' },
            { surfaceId: 'capture-ready-gate', body: 'second' },
          ],
        }),
      ),
    /invalid entries: surfaceNotes\[1\]/u,
  );
  assert.throws(
    () =>
      feedbackDraftFromDocument(
        readyGateSource,
        feedback([point, { ...point, id: 'd', body: '  ' }]),
      ),
    /invalid entries: annotations\[1\]/u,
  );
  assert.throws(
    () =>
      feedbackDraftFromDocument(
        readyGateSource,
        feedback([point, { ...point, id: 'e', color: 'invalid' }]),
      ),
    /invalid entries: annotations\[1\]/u,
  );
  assert.throws(
    () => feedbackDraftFromDocument(readyGateSource, feedback([point, { ...point, id: '' }])),
    /invalid entries: annotations\[1\]/u,
  );
  assert.throws(
    () => feedbackDraftFromDocument(readyGateSource, feedback([point, point])),
    /invalid entries: annotations\[1\]/u,
  );
  assert.throws(
    () =>
      feedbackDraftFromDocument(
        readyGateSource,
        feedback([point], {
          source: { ...readyGateSource, capturedAt: '2026-09-24T00:00:00.000Z' },
        }),
      ),
    /written for the capture of 2026-09-24T00:00:00\.000Z/u,
  );
  assert.deepEqual(
    feedbackDraftFromDocument(readyGateSource, feedback([point])).annotations.map(({ id }) => id),
    ['c'],
  );
  const builtinNamed = {
    ...readyGateSource,
    surfaces: [{ ...readyGateSource.surfaces[0], id: 'constructor', parentId: undefined }],
  };
  assert.deepEqual(
    feedbackDraftFromDocument(builtinNamed, {
      ...feedback([], { source: builtinNamed }),
      surfaceNotes: [{ surfaceId: 'constructor', body: 'kept' }],
    }).surfaceNotes,
    { constructor: 'kept' },
  );
});
