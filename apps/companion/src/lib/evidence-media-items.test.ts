import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createEvidenceReviewModel,
  type EvidenceReviewModel,
} from '@farmslot/adapter-sdk/evidence';
import type { RecordedEvidencePackageInput } from '@farmslot/protocol';

import { evidenceRecordingForPath, selectedEvidenceMediaItem } from './evidence-media-items';

const fixture: { input: RecordedEvidencePackageInput } = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/recipe-runner/test/fixtures/visual-review-package.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

test('a prose-captioned video retains its checked media type', () => {
  const model = createEvidenceReviewModel({
    package: fixture.input,
    artifactPrefix: 'artifacts/head/',
  });
  model.selectClaim('check-1');
  assert.ok(model.playback.clip);
  const path = model.artifactPath(model.playback.clip.videoPath);
  const item = selectedEvidenceMediaItem(model, path, (value) => value, {});
  assert.equal(item.mediaType, 'video');
  assert.equal(item.path, path);
  assert.equal(item.evidenceModel, model);
  assert.equal(item.initialTraceIndex, model.playback.clip.traceIndex);
});

test('baseline and head recording filenames do not share markers', () => {
  const model = createEvidenceReviewModel({
    package: fixture.input,
    artifactPrefix: 'artifacts/head/',
  });
  const head = model.recordings[0];
  assert.ok(head);
  const path = `comparison-dependencies/baseline/${head.videoPath}`;
  const baseline = { ...head, videoPath: path };
  const both: EvidenceReviewModel = { ...model, recordings: [head, baseline] };
  assert.equal(evidenceRecordingForPath(both, model.artifactPath(path)), baseline);
  assert.equal(evidenceRecordingForPath(both, model.artifactPath(head.videoPath)), head);
  assert.equal(evidenceRecordingForPath(both, `another-attempt/${head.videoPath}`), undefined);
});
