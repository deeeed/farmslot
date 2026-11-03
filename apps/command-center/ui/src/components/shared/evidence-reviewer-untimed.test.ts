import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';

import { evidenceReviewerSelection } from './evidence-reviewer-recording.js';

test('a criterion with an untimed original opens its recording without a timeline', () => {
  const model = createEvidenceReviewModel({
    ledger: {
      schemaVersion: 1,
      criteria: [
        {
          id: 'AC-1',
          text: 'Inspect the retained proof.',
          verdict: 'proven',
          recipeNodes: [],
          evidence: [
            'artifacts/recipe-runs/selected/videos/recipe-run.mp4',
            'artifacts/recipe-runs/selected/screenshots/after.png',
          ],
        },
      ],
    },
  });
  assert.equal(model.recordings.length, 0, 'no measured timeline was captured');
  const selected = evidenceReviewerSelection({
    model,
    claimId: 'AC-1',
    resolveUrl: (path) => `/proof/${path}`,
  });
  assert.equal(selected.recording?.path, 'artifacts/recipe-runs/selected/videos/recipe-run.mp4');
  assert.equal(
    selected.recording?.url,
    '/proof/artifacts/recipe-runs/selected/videos/recipe-run.mp4',
  );
  assert.equal(model.selectClaim('AC-1')?.timing, 'untimed');
  assert.deepEqual(model.selection?.clips, []);
});
