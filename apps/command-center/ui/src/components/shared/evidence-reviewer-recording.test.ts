import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';

import { evidenceReviewerSelection } from './evidence-reviewer-recording.js';

const path = 'artifacts/recipe-runs/proof-24/videos/recipe-run.mp4';
const gate = createEvidenceReviewModel({
  ledger: {
    schemaVersion: 1,
    criteria: [
      {
        id: 'AC-1',
        text: 'Inspect this original.',
        verdict: 'proven',
        evidence: [path],
        recipeNodes: [],
      },
    ],
  },
});

test('a file path finds its original even without measured markers', () => {
  assert.equal(gate.recordingForPath(path)?.videoPath, path);
  assert.equal(gate.recordingForPath(path)?.hasTimeline, false);
  assert.equal(gate.recordingForPath('artifacts/videos/recipe-run.mp4'), undefined);
});

test('another attempt cannot replace the selected criterion recording', () => {
  const opened = { path: 'artifacts/videos/recipe-run.mp4', url: '/foreign', purpose: 'video' };
  const selection = evidenceReviewerSelection({
    model: gate,
    claimId: 'AC-1',
    opened,
    resolveUrl: (value) => value,
  });
  assert.equal(selection.opened, undefined);
  assert.equal(selection.recording?.path, path);
  const pending = evidenceReviewerSelection({
    model: createEvidenceReviewModel({}),
    claimId: 'AC-1',
    opened,
    resolveUrl: (value) => value,
  });
  assert.equal(
    pending.recording,
    opened,
    'unread metadata does not yet classify a recording as foreign',
  );
});
