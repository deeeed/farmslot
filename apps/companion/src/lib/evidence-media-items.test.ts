import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createEvidenceReviewModel, evidenceReviewToc } from '@farmslot/adapter-sdk/evidence';
import type { RecordedEvidencePackageInput } from '@farmslot/protocol';

import { untimedRecordingFixture } from '../../../../packages/adapter-sdk/test/untimed-fixture';

import {
  evidenceClaimPlayback,
  evidenceMediaItems,
  evidenceRecordingForPath,
  evidenceViewerSelection,
  evidenceViewerSessionItems,
  recordedEvidenceArtifactUrl,
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
  const both = createEvidenceReviewModel({
    artifactPrefix: 'artifacts/head/',
    recordings: [head, baseline].map((timeline) => ({
      timeline,
      videoPath: timeline.videoPath,
      videoDigest: timeline.videoDigest,
      trace: fixture.input.trace,
    })),
  });
  assert.deepEqual(both.errors, []);
  assert.equal(
    evidenceRecordingForPath(both, model.artifactPath(path))?.videoPath,
    baseline.videoPath,
  );
  assert.equal(
    evidenceRecordingForPath(both, model.artifactPath(head.videoPath))?.videoPath,
    head.videoPath,
  );
  assert.equal(
    evidenceRecordingForPath(both, model.artifactPath(head.videoPath))?.hasTimeline,
    true,
  );
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

test("choosing a criterion from the recording's contents plays from its moment", () => {
  const model = createEvidenceReviewModel({
    package: fixture.input,
    artifactPrefix: 'artifacts/head/',
  });
  const recording = model.recordings[0];
  assert.ok(recording);
  const recorded = evidenceReviewToc(model, recording.videoPath).filter(
    (entry) => entry.startMs !== null,
  );
  assert.ok(recorded.length > 0, 'the fixture recording reaches at least one criterion');
  let clipped = 0;
  for (const entry of recorded) {
    const chosen = evidenceClaimPlayback(model, entry.claim.id, recording.videoPath, entry.startMs);
    assert.equal(model.selection?.claimId, entry.claim.id);
    assert.equal(chosen?.effect?.seekMs, entry.startMs);
    assert.equal(chosen?.effect?.sourceChanged, false);
    assert.equal(chosen?.effect?.pause, false);
    // The moment sits inside the clip the model now plays, so its playback keeps the seek.
    const clip = chosen?.effect?.clip;
    if (clip && entry.startMs !== null) {
      clipped++;
      assert.ok(entry.startMs >= clip.startMs && entry.startMs <= clip.endMs, entry.claim.id);
      const kept = model.playbackAt(recording.videoPath, entry.startMs);
      assert.notEqual(kept.pause, true, `${entry.claim.id} plays on from its moment`);
    }
  }
  assert.ok(clipped > 0, 'at least one criterion plays a clip of this recording');
  // Without a moment, the criterion's own clip on this recording is where it plays from.
  const first = recorded[0]!;
  const fallback = evidenceClaimPlayback(model, first.claim.id, recording.videoPath, null);
  const clip = model.selection?.clips.find((value) => value.videoPath === recording.videoPath);
  assert.equal(fallback?.effect?.seekMs ?? null, clip ? clip.startMs : null);
  assert.equal(
    evidenceClaimPlayback(model, 'not-a-criterion', recording.videoPath, 1000),
    undefined,
  );
});

test('untimed review keeps same-attempt screenshots as inspection context', () => {
  const input = untimedRecordingFixture(fixture.input);
  const model = createEvidenceReviewModel({
    package: input,
    artifactPrefix: 'artifacts/selected/',
  });
  model.selectClaim('check-1');
  const media = model.claimMedia('check-1');
  assert.ok(media.recording);
  const opening = selectedEvidenceMediaItem(
    model,
    media.recording.artifactPath,
    (value) => `/proof/${value}`,
    {},
    { runId: 'run-proof' },
  );
  const items = evidenceViewerSessionItems([opening], opening.uri);
  assert.ok(
    items.some((item) => item.mediaType === 'image' && item.title?.includes('not AC-bound')),
  );
  assert.ok(
    items
      .filter((item) => item.mediaType === 'image')
      .every(
        (item) =>
          item.sharedArtifact?.traceIndex === undefined &&
          item.sharedArtifact?.criterionId === undefined,
      ),
  );
  assert.ok(items.every((item) => item.path?.startsWith('artifacts/selected/')));
  assert.equal(evidenceRecordingForPath(model, opening.path)?.hasTimeline, false);
  assert.equal(model.selection?.timing, 'untimed');
  assert.deepEqual(model.selection?.clips, []);
});

test('a baseline selection does not add head screenshots to the native viewer', () => {
  const head = createEvidenceReviewModel({
    package: untimedRecordingFixture(fixture.input),
    artifactPrefix: 'artifacts/head/',
  });
  const baseline = createEvidenceReviewModel({
    package: untimedRecordingFixture(fixture.input),
    artifactPrefix: 'artifacts/baseline/',
  });
  baseline.selectClaim('check-1');
  assert.ok(baseline.selection);
  // A comparison selects baseline files while retaining the head's claim catalogue.
  const model = { ...head, selection: baseline.selection };
  const path = baseline.claimMedia('check-1').recording?.artifactPath;
  assert.ok(path);
  const opening = selectedEvidenceMediaItem(model, path, (value) => `/proof/${value}`, {});
  const items = evidenceViewerSessionItems([opening], opening.uri);
  assert.deepEqual(
    items.map((item) => item.path),
    [path],
  );
});
