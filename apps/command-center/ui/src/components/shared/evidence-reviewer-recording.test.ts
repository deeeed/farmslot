import assert from 'node:assert/strict';
import test from 'node:test';

import { isForeignRecording, modelRecording } from './evidence-reviewer-recording.js';

const gate = {
  recordings: [{ videoPath: 'videos/recipe-run.mp4' }],
  artifactPath: (path: string) => `artifacts/recipe-runs/proof-24/${path}`,
};

test('a file path finds the recording it shows', () => {
  assert.equal(
    modelRecording(gate, 'artifacts/recipe-runs/proof-24/videos/recipe-run.mp4'),
    gate.recordings[0],
  );
  assert.equal(modelRecording(gate, 'artifacts/videos/recipe-run.mp4'), undefined);
});

test("another run's recording is foreign once the model knows its own", () => {
  assert.equal(isForeignRecording(gate, 'artifacts/videos/recipe-run.mp4'), true);
  assert.equal(
    isForeignRecording(gate, 'artifacts/recipe-runs/proof-24/videos/recipe-run.mp4'),
    false,
  );
  // Before the model's recordings load, nothing is foreign yet.
  assert.equal(
    isForeignRecording({ ...gate, recordings: [] }, 'artifacts/videos/recipe-run.mp4'),
    false,
  );
});
