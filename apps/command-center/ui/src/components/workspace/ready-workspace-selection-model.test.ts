import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReadyGatePayload } from '@farmslot/protocol';

import {
  excludeReadyEvidenceVideos,
  initialReadyEvidenceSelection,
  readyEvidenceSelectionKey,
  readyPublicationTarget,
  readyPublicationTargetKey,
  readyPublishEvidenceSet,
  selectedReadyEvidenceKeysForSubmit,
  setAllReadyEvidenceIncluded,
  setReadyEvidenceIncluded,
} from './ready-workspace-selection-model.js';

function payload(overrides: Record<string, unknown>): ReadyGatePayload {
  return overrides as unknown as ReadyGatePayload;
}

test('ready workspace selection model hydrates publication target and evidence keys', () => {
  const input = payload({
    publicationTarget: 'draft',
    prPackage: {
      packageHash: 'hash-1',
      selectedEvidenceKeys: ['after.png', 'missing.png', 'after.png'],
    },
  });

  assert.equal(readyPublicationTarget(input), 'draft');
  assert.equal(
    readyPublicationTargetKey({ decisionId: 'decision-1', payload: input }),
    'decision-1:hash-1:draft',
  );
  assert.equal(
    readyEvidenceSelectionKey({ decisionId: 'decision-1', payload: input }),
    'decision-1:hash-1',
  );
  assert.deepEqual(initialReadyEvidenceSelection(input, ['after.png', 'video.mp4']), ['after.png']);
});

test('ready workspace selection model mutates evidence selection within candidate order', () => {
  const candidates = ['before.png', 'after.png', 'demo.mp4'];

  assert.deepEqual(
    [...readyPublishEvidenceSet(null, candidates)],
    ['before.png', 'after.png', 'demo.mp4'],
  );
  assert.deepEqual(
    setReadyEvidenceIncluded({
      selectedEvidenceKeys: ['before.png'],
      candidateKeys: candidates,
      artifactPath: 'after.png',
      included: true,
    }),
    ['before.png', 'after.png'],
  );
  assert.deepEqual(
    setReadyEvidenceIncluded({
      selectedEvidenceKeys: ['before.png', 'after.png'],
      candidateKeys: candidates,
      artifactPath: 'before.png',
      included: false,
    }),
    ['after.png'],
  );
  assert.deepEqual(setAllReadyEvidenceIncluded(candidates, true), candidates);
  assert.deepEqual(setAllReadyEvidenceIncluded(candidates, false), []);
});

test('ready workspace selection model excludes selected videos and prepares submit keys', () => {
  const candidates = [
    { path: 'before.png', purpose: 'screenshot' },
    { path: 'demo.webm', purpose: 'recording' },
    { path: 'after.png', purpose: 'screenshot' },
  ];

  assert.deepEqual(excludeReadyEvidenceVideos({ selectedEvidenceKeys: null, candidates }), [
    'before.png',
    'after.png',
  ]);
  assert.deepEqual(selectedReadyEvidenceKeysForSubmit(null, ['before.png']), ['before.png']);
  assert.deepEqual(selectedReadyEvidenceKeysForSubmit([], ['before.png']), []);
});
