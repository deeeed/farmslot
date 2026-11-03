import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { RecordedEvidencePackageInput } from '@farmslot/protocol';
import { untimedRecordingFixture } from '../../../../../../packages/adapter-sdk/test/untimed-fixture.js';

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

test('reopening an inspection screenshot URL retains its non-AC caption', () => {
  const fixture: { input: RecordedEvidencePackageInput } = JSON.parse(
    readFileSync(
      new URL(
        '../../../../../../packages/recipe-runner/test/fixtures/visual-review-package.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const model = createEvidenceReviewModel({
    package: untimedRecordingFixture(fixture.input),
    artifactPrefix: 'artifacts/selected/',
  });
  const screenshot = model.claimMedia('check-1').screenshots.find((file) => file.inspection);
  assert.ok(screenshot);
  const path = screenshot.artifact.artifactPath;
  const selection = evidenceReviewerSelection({
    model,
    claimId: 'check-1',
    resolveUrl: (value) => `/proof/${value}`,
    opened: { path, url: `/proof/${path}`, purpose: 'evidence', evidenceModel: model },
  });
  assert.equal(
    selection.opened?.evidenceModel,
    undefined,
    'inspection context must not render the selected claim caption',
  );
  assert.equal(selection.opened?.caption, 'Same-attempt inspection context · not AC-bound');
});
