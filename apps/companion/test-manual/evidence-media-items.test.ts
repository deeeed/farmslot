import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createEvidenceReviewModel,
  type EvidenceReviewModel,
} from '@farmslot/adapter-sdk/evidence';
import type { RecordedEvidencePackageInput } from '@farmslot/protocol';
import { resolveSharedViewLink } from '@farmslot/protocol/surfaces/view-links';

import {
  evidenceMediaItems,
  evidenceRecordingForPath,
  evidenceViewerSelection,
  mediaShareView,
  recordedEvidenceArtifactUrl,
  selectedEvidenceMediaItem,
} from '../src/lib/evidence-media-items';

const fixture: { input: RecordedEvidencePackageInput } = JSON.parse(
  readFileSync(
    new URL(
      '../../../packages/recipe-runner/test/fixtures/visual-review-package.json',
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

test('selecting Unassigned media replaces a prior claim in the recorded viewer', () => {
  const path = 'artifacts/ordinary.png';
  const model = createEvidenceReviewModel({
    package: fixture.input,
    artifactPrefix: 'artifacts/head/',
    artifacts: [{ path, purpose: 'evidence', type: 'image' }],
  });
  model.selectClaim('check-1');
  assert.ok(model.playback.clip);
  model.setComparisonFilter('unassigned');
  const media = model.comparisonView.unassigned.find((entry) => entry.artifactPath === path);
  assert.ok(media);
  model.selectComparisonMedia(media.identity);
  const item = selectedEvidenceMediaItem(model, path, (value) => value, {});
  assert.deepEqual(
    model.selection?.artifacts.map((entry) => entry.artifactPath),
    [path],
  );
  assert.equal(model.playback.clip, null);
  assert.equal(item.mediaType, 'image');
  assert.equal(evidenceViewerSelection(item.uri, [], [item]).index, 0);
});

test('recorded media and dependent URLs keep the model bundle and full task path', () => {
  const digest = 'a'.repeat(64);
  const videoPath = `artifacts/head/${fixture.input.claims?.recording.segments[0]?.videoPath}`;
  const model = createEvidenceReviewModel({
    package: fixture.input,
    artifactPrefix: 'artifacts/head/',
    report: {
      artifactManifest: [
        { path: videoPath, purpose: 'evidence' },
        { path: 'artifacts/head/timeline.json', purpose: 'evidence' },
      ],
      manifestDigest: 'recorded-inventory',
      artifactBundle: {
        storeId: 'recorded-store',
        taskKey: 'recorded-task',
        bundleDigest: digest,
        manifestDigest: 'recorded-inventory',
      },
    },
  });
  model.selectClaim('check-1');
  const path = model.artifactPath(model.playback.clip!.videoPath);
  const resolve = (path: string) =>
    recordedEvidenceArtifactUrl('ws://gateway/ws', 'retained-run', model, path);
  const item = selectedEvidenceMediaItem(model, path, resolve, {});
  for (const uri of [item.uri, item.resolveArtifactUrl!('artifacts/head/timeline.json')]) {
    const url = new URL(uri);
    assert.equal(url.searchParams.get('bundleDigest'), digest);
    assert.equal(url.searchParams.get('recipeRunId'), 'current-artifacts');
    assert.equal(url.searchParams.get('runId'), 'retained-run');
  }
  assert.equal(new URL(item.uri).searchParams.get('path'), path);
  assert.equal(
    new URL(item.resolveArtifactUrl!('artifacts/head/timeline.json')).searchParams.get('path'),
    'artifacts/head/timeline.json',
  );
  assert.equal(
    new URL(resolve('artifacts/selected-root.png')).searchParams.get('recipeRunId'),
    null,
  );
  assert.equal(
    new URL(resolve('artifacts/selected-root.png')).searchParams.get('bundleDigest'),
    digest,
  );
  const gallery = evidenceMediaItems(
    [{ path, purpose: 'evidence' }],
    (artifact) => recordedEvidenceArtifactUrl('ws://gateway/ws', 'retained-run', model, artifact),
    {},
    model,
  );
  assert.equal(gallery[0].uri, item.uri);
  assert.equal(evidenceViewerSelection(item.uri, gallery, null).index, 0);
  assert.equal(
    gallery[0].resolveArtifactUrl!('artifacts/head/timeline.json'),
    item.resolveArtifactUrl!('artifacts/head/timeline.json'),
  );
});

test('gallery entries preserve explicit bundle and execution identities without a model', () => {
  const artifact = {
    path: 'artifacts/ordinary.png',
    purpose: 'evidence',
    recipeRunId: 'baseline-execution',
    bundleDigest: 'b'.repeat(64),
  };
  const model = createEvidenceReviewModel({
    package: fixture.input,
    report: {
      artifactManifest: [artifact],
      manifestDigest: 'inventory',
      artifactBundle: {
        storeId: 'store',
        taskKey: 'task',
        bundleDigest: 'a'.repeat(64),
        manifestDigest: 'inventory',
      },
    },
  });
  for (const evidenceModel of [model, null]) {
    const url = new URL(
      recordedEvidenceArtifactUrl('ws://gateway/ws', 'run', evidenceModel, artifact),
    );
    assert.equal(url.searchParams.get('bundleDigest'), artifact.bundleDigest);
    assert.equal(url.searchParams.get('recipeRunId'), artifact.recipeRunId);
    assert.equal(url.searchParams.get('path'), artifact.path);
  }
  const unbound = new URL(
    recordedEvidenceArtifactUrl('ws://gateway/ws', 'run', null, 'artifacts/ordinary.png'),
  );
  assert.equal(unbound.searchParams.get('bundleDigest'), null);
  assert.equal(unbound.searchParams.get('recipeRunId'), null);
});

test('a changed video selection refuses the opening artifact until a new observed item opens', () => {
  const opened = { runId: 'run-A', path: 'recording-A.mp4', traceIndex: 3 };
  const initial = mediaShareView(opened, false);
  assert(initial);
  assert.equal(
    resolveSharedViewLink({ companion: initial }, 'https://cc.example/').status,
    'available',
  );
  const changed = mediaShareView(opened, true);
  assert(changed);
  const refused = resolveSharedViewLink({ companion: changed }, 'https://cc.example/');
  assert.equal(refused.status, 'unavailable');
  if (refused.status === 'unavailable')
    assert.match(refused.message, /selected recording or occurrence/);
  const reopened = mediaShareView(
    { runId: 'run-A', path: 'recording-B.mp4', traceIndex: 7 },
    false,
  );
  assert(reopened);
  const result = resolveSharedViewLink({ companion: reopened }, 'https://cc.example/');
  assert(result.status === 'available');
  assert.match(result.route, /artifact=recording-B.mp4/);
  assert.match(result.route, /artifactTrace=7/);
});
