import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createEvidenceReviewModel,
  type EvidenceReviewModel,
} from '@farmslot/adapter-sdk/evidence';
import type { RecordedEvidencePackageInput } from '@farmslot/protocol';

import {
  evidenceRecordingForPath,
  evidenceViewerSelection,
  selectedEvidenceMediaItem,
} from './evidence-media-items';

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

test('a recorded moment opens from its own items when the manifest URL differs', () => {
  const manifest = [{ uri: 'https://gateway/video?recipeRunId=retained' }];
  const moment = [
    { uri: 'https://gateway/video', mediaType: 'video' as const, initialTraceIndex: 4 },
  ];
  const selected = evidenceViewerSelection(moment[0].uri, manifest, moment);
  assert.equal(selected.items, moment);
  assert.equal(selected.index, 0);
  assert.equal(selected.items[selected.index].initialTraceIndex, 4);
});

test('an ordinary visual opens its own list despite a retained comparison selection', () => {
  const manifest = [{ uri: 'https://gateway/first.png' }, { uri: 'https://gateway/second.png' }];
  const moment = [{ uri: 'https://gateway/video', initialTraceIndex: 4 }];
  const selected = evidenceViewerSelection(manifest[1].uri, manifest, moment);
  assert.equal(selected.items, manifest);
  assert.equal(selected.index, 1);
  assert.equal(selected.items[selected.index].initialTraceIndex, undefined);
  assert.equal(evidenceViewerSelection(null, manifest, moment).index, -1);
  assert.equal(evidenceViewerSelection('https://gateway/missing', manifest, moment).index, -1);
});
