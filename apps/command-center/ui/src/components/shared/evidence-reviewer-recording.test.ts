import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import type { RecipeRecordingTimelineDocument, RecipeRunArtifactGroup } from '@farmslot/protocol';

import {
  evidenceRecordingPin,
  evidenceRecordingRevision,
  evidenceReviewerSelection,
  evidenceReviewerTimeline,
  gateReviewArtifactPath,
  gateReviewAttemptMatches,
} from './evidence-reviewer-recording.js';

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
  assert.equal(gate.recordingTimelineForPath(path), undefined);
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
  assert.equal(selection.linkedRecordingUnavailable, true);
  assert.equal(selection.recording?.path, path);
  const pending = evidenceReviewerSelection({
    model: createEvidenceReviewModel({}),
    claimId: 'AC-1',
    opened,
    resolveUrl: (value) => value,
  });
  assert.equal(pending.linkedRecordingUnavailable, undefined);
  assert.equal(
    pending.recording,
    opened,
    'unread metadata does not yet classify a recording as foreign',
  );
});

const videoPath = 'videos/run.mp4';
const digest = `sha256:${'a'.repeat(64)}`;
const timeline: RecipeRecordingTimelineDocument = {
  version: 1,
  videoPath,
  videoDigest: digest,
  traceDigest: `sha256:${'b'.repeat(64)}`,
  framesMs: [0, 50, 100, 150, 190],
  durationMs: 200,
  clock: { source: 'observed', earliestZeroUnixMs: 1000, latestZeroUnixMs: 1000 },
  markers: [
    {
      traceIndex: 1,
      nodeId: 'open',
      action: 'ui.press',
      intent: 'Open the market',
      ok: true,
      startRangeMs: [50, 50],
      endRangeMs: [100, 100],
    },
    {
      traceIndex: 0,
      nodeId: 'setup',
      action: 'ui.start',
      ok: true,
      startRangeMs: [-200, -200],
      endRangeMs: [-100, -100],
    },
    {
      traceIndex: 3,
      nodeId: 'done',
      action: 'done',
      ok: true,
      startRangeMs: [200, 200],
      endRangeMs: [200, 200],
    },
  ],
};
const model = {
  recordingTimelineForPath: () => ({ timeline, current: true }),
  currentOccurrences: [
    {
      traceIndex: 2,
      nodeId: 'check',
      action: 'assert',
      intent: 'Check the receipt',
      ok: false,
      proves: [],
      artifacts: [],
    },
  ],
  markerSeekMs: (_videoPath: string, index: number) => (index === 1 ? 50 : null),
  errors: [],
};

test('recording timeline follows the entire current trace and keeps unseekable rows', () => {
  assert.deepEqual(evidenceReviewerTimeline(model, path)?.page(0, 25), [
    { traceIndex: 0, intent: 'setup', ok: true, atMs: null, timeLabel: 'Before recording' },
    { traceIndex: 1, intent: 'Open the market', ok: true, atMs: 50, timeLabel: '0:00' },
    {
      traceIndex: 2,
      intent: 'Check the receipt',
      ok: false,
      atMs: null,
      timeLabel: 'Time unavailable',
    },
    { traceIndex: 3, intent: 'done', ok: true, atMs: null, timeLabel: 'After recording' },
  ]);
});

test('a retained original only uses its own markers, including when the current trace reuses indexes', () => {
  const retained = { ...timeline, markers: [{ ...timeline.markers[1]!, traceIndex: 2 }] };
  const rows = evidenceReviewerTimeline(
    { ...model, recordingTimelineForPath: () => ({ timeline: retained, current: false }) },
    path,
  );
  assert.deepEqual(
    rows?.page(0, 25).map((row) => row.intent),
    ['setup'],
  );
});

test('retained trace rows stay visible when their sidecar has no marker', () => {
  const source = {
    ...model,
    recordingTimelineForPath: () => ({
      timeline: { ...timeline, markers: [] },
      current: false,
      retainedOccurrences: [{ traceIndex: 5, intent: 'Retained setup', ok: true }],
    }),
  };
  const index = evidenceReviewerTimeline(source, path);
  assert.equal(evidenceReviewerTimeline(source, path), index);
  assert.deepEqual(
    index?.page(0, 25).map((row) => [row.traceIndex, row.atMs]),
    [[5, null]],
  );
});

test('a missing or invalid recording has no timeline rows', () => {
  assert.equal(
    evidenceReviewerTimeline({ ...model, recordingTimelineForPath: () => undefined }, path),
    undefined,
  );
  assert.equal(
    evidenceReviewerTimeline({ ...model, errors: ['invalid binding'] }, path),
    undefined,
  );
});

test('a verified untimed recording lists its own trace without a seek', () => {
  const untimed = { ...model, recordingTimelineForPath: () => ({ current: true }) };
  assert.deepEqual(evidenceReviewerTimeline(untimed, path)?.page(0, 25), [
    {
      traceIndex: 2,
      intent: 'Check the receipt',
      ok: false,
      atMs: null,
      timeLabel: 'Time unavailable',
    },
  ]);
});

test('timeline positions are resolved only for the requested page', () => {
  const seeks: number[] = [];
  const projected = evidenceReviewerTimeline(
    {
      ...model,
      markerSeekMs: (_path, index) => {
        seeks.push(index);
        return null;
      },
    },
    path,
  );
  assert.equal(projected?.stepCount, 4);
  assert.deepEqual(seeks, []);
  const page = projected?.page(0, 2);
  assert.deepEqual(seeks, [0, 1]);
  assert.equal(projected?.page(0, 2), page);
  assert.deepEqual(seeks, [0, 1]);
  projected?.page(2, 2);
  assert.deepEqual(seeks, [0, 1, 3]);
});

test('a verified unchanged sidecar keeps its index across model refreshes', () => {
  const first = {
    ...model,
    recordingTimelineForPath: () => ({ timeline, current: true, sidecarDigest: 'verified' }),
  };
  const indexed = evidenceReviewerTimeline(first, path);
  assert.ok(indexed);
  const refreshed = { ...first, markerSeekMs: () => null };
  const reused = evidenceReviewerTimeline(refreshed, path, indexed);
  assert.equal(reused, indexed);
  assert.equal(reused?.page(1, 1, refreshed)[0]?.atMs, null);
  const newBytes = {
    ...refreshed,
    recordingTimelineForPath: () => ({ timeline, current: true, sidecarDigest: 'new' }),
  };
  assert.notEqual(evidenceReviewerTimeline(newBytes, path, indexed), indexed);
});

test('a linked still keeps its separately selected timeline recording', () => {
  const still = 'artifacts/stills/first.webp';
  const alternate = 'artifacts/alternate/videos/recipe-run.mp4';
  const model = createEvidenceReviewModel({
    ledger: {
      schemaVersion: 1,
      criteria: [
        {
          id: 'AC-1',
          text: 'Inspect the still.',
          verdict: 'proven',
          evidence: [still, path],
          recipeNodes: [],
        },
        {
          id: 'AC-2',
          text: 'Inspect the other recording.',
          verdict: 'proven',
          evidence: [alternate],
          recipeNodes: [],
        },
      ],
    },
  });
  const selection = evidenceReviewerSelection({
    model,
    claimId: 'AC-1',
    opened: { path: still, url: still, purpose: 'image' },
    recordingPath: alternate,
    resolveUrl: (media) => media,
  });
  assert.equal(selection.recording?.path, alternate);
  assert.equal(selection.recordingPath, alternate);
  assert.equal(selection.opened?.path, still);
});

test('a missing linked recording keeps its identity and prevents substitution', () => {
  const model = createEvidenceReviewModel({
    ledger: {
      schemaVersion: 1,
      criteria: [
        { id: 'AC-1', text: 'Review', verdict: 'proven', evidence: [path], recipeNodes: [] },
      ],
    },
  });
  const selection = evidenceReviewerSelection({
    model,
    claimId: 'AC-1',
    recordingPath: 'missing.mp4',
    resolveUrl: (media) => media,
  });
  assert.equal(selection.recordingPath, 'missing.mp4');
  assert.equal(selection.recording, null);
  assert.equal(selection.linkedRecordingUnavailable, true);
});

test('a shorter loaded video disables steps past its end', () => {
  const source = {
    ...model,
    markerSeekMs: (_path: string, _index: number, _phase: 'start' | 'end', duration?: number) =>
      duration !== undefined && duration <= 50 ? null : 50,
  };
  const indexed = evidenceReviewerTimeline(source, path);
  assert.equal(indexed?.page(1, 1, source)[0]?.atMs, 50);
  assert.equal(indexed?.page(1, 1, source, 40)[0]?.atMs, null);
});

test('a recipe alias cannot restore a timed link onto replacement video bytes', () => {
  const model = createEvidenceReviewModel({
    ledger: {
      schemaVersion: 1,
      criteria: [
        { id: 'AC-1', text: 'Review', verdict: 'proven', evidence: [path], recipeNodes: [] },
      ],
    },
  });
  const replaced = {
    ...model,
    recordingForPath: () => ({
      videoPath,
      videoDigest: 'sha256:' + 'a'.repeat(64),
      hasTimeline: true,
    }),
  };
  const selection = evidenceReviewerSelection({
    model: replaced,
    claimId: 'AC-1',
    opened: { path, url: path, purpose: 'recording' },
    recordingPath: path,
    recordingRevision: 'sha256:' + 'b'.repeat(64),
    resolveUrl: (media) => media,
  });
  assert.equal(selection.recording, null);
  assert.equal(selection.linkedRecordingUnavailable, true);
  assert.equal(selection.recordingPath, path);
});

test('a verified recording pins the media request even when its path is task-relative', () => {
  const model = createEvidenceReviewModel({
    ledger: {
      schemaVersion: 1,
      criteria: [
        { id: 'AC-1', text: 'Review', verdict: 'proven', evidence: [path], recipeNodes: [] },
      ],
    },
  });
  const digest = 'a'.repeat(64);
  const retained = {
    ...model,
    recordingForPath: () => ({
      videoPath,
      videoDigest: 'sha256:' + digest,
      hasTimeline: true,
    }),
  };
  const url =
    '/api/run-artifact?runId=r&bundleDigest=older-bundle&path=' + encodeURIComponent(path);
  const selection = evidenceReviewerSelection({
    model: retained,
    claimId: 'AC-1',
    opened: { path, url, purpose: 'recording' },
    resolveUrl: () => url,
  });
  const saved = new URL(selection.recording!.url, 'http://localhost:7801');
  assert.ok(selection.recording!.url.startsWith('/api/'));
  assert.equal(saved.searchParams.get('bundleDigest'), 'older-bundle');
  assert.equal(saved.searchParams.get('v'), digest);
});

test('a Run Detail link resolves inside the selected gate package namespace', () => {
  const gateModel = {
    ...gate,
    artifactPath: (relative: string) => 'artifacts/recipe-runs/proof-24/' + relative,
  };
  assert.equal(gateReviewArtifactPath(gateModel, 'artifacts/videos/recipe-run.mp4'), path);
  assert.equal(gateReviewArtifactPath(gateModel, path), path);
  assert.equal(
    gateReviewArtifactPath(gateModel, 'artifacts/stills/review.png'),
    'artifacts/recipe-runs/proof-24/stills/review.png',
  );
  assert.equal(gateReviewArtifactPath(gateModel, 'reports/summary.html'), 'reports/summary.html');
});

test('an untimed link rejects a changed trace even when its video digest is unchanged', () => {
  const first = {
    ...gate,
    recordingForPath: () => ({ videoPath, videoDigest: digest, hasTimeline: false }),
    recordingTimelineForPath: () => ({ current: true, videoDigest: digest, traceDigest: 'trace1' }),
  };
  const next = {
    ...first,
    recordingTimelineForPath: () => ({ current: true, videoDigest: digest, traceDigest: 'trace2' }),
  };
  const revision = evidenceRecordingRevision(first, path);
  assert.ok(revision?.includes('trace1'));
  assert.notEqual(evidenceRecordingRevision(next, path), revision);
  const stale = evidenceReviewerSelection({
    model: next,
    claimId: 'AC-1',
    recordingPath: path,
    recordingRevision: revision,
    resolveUrl: (file) => file,
  });
  assert.equal(stale.recording, null);
  assert.equal(stale.linkedRecordingUnavailable, true);
});

test('opening a fallback video leaves only its file link until its recording is resolved', () => {
  const media = 'artifacts/videos/fallback.mp4';
  const initial = createEvidenceReviewModel({});
  assert.deepEqual(evidenceRecordingPin(initial, media), {});
  const hydrated = {
    ...initial,
    recordingForPath: () => ({
      videoPath: media,
      videoDigest: digest,
      hasTimeline: true,
      timelineDigest: 'clock',
    }),
  };
  assert.deepEqual(evidenceRecordingPin(hydrated, media), {
    recordingPath: media,
    recordingRevision: digest + '.clock',
  });
});

test('gate review builds a recipe-group alias index once per loaded inventory', () => {
  let reads = 0;
  const group: RecipeRunArtifactGroup = {
    get id() {
      reads++;
      return 'alias';
    },
    label: 'Captured evidence',
    recipeRunId: 'owning-attempt',
    groupKind: 'latest-valid',
    source: 'recipe-run-artifacts',
    promoted: true,
    status: 'pass',
    artifactRoot: '/fixture',
    artifactManifest: null,
    recipeJson: null,
    recipeQualityArtifact: null,
    qualityReport: null,
    workerLearnings: null,
    isStale: false,
    selectionReason: 'decision-derived',
  };
  const source = { recipeRuns: [group], selectedRecipeRunId: 'owning-attempt' };
  assert.equal(gateReviewAttemptMatches(source), true);
  assert.equal(reads, 0);
  assert.equal(gateReviewAttemptMatches(source, 'alias'), true);
  assert.equal(gateReviewAttemptMatches(source, 'missing'), false);
  assert.equal(gateReviewAttemptMatches(source, 'alias'), true);
  assert.equal(reads, 1);
  assert.equal(gateReviewAttemptMatches({ ...source, recipeRuns: [] }, 'alias'), false);
});

test('rotated originals read the trace once and resolve only their requested timing page', () => {
  const secondPath = 'artifacts/videos/second.mp4';
  const base = model.currentOccurrences[0]!;
  let traceReads = 0;
  const occurrences = Array.from({ length: 60 }, (_, traceIndex) => ({
    ...base,
    get traceIndex() {
      traceReads++;
      return traceIndex;
    },
    intent: 'Trace ' + traceIndex,
  })).reverse();
  const seeks: Array<[string, number]> = [];
  const firstMarker = { ...timeline.markers[0]!, traceIndex: 26 };
  const secondMarker = {
    ...firstMarker,
    intent: 'Other segment',
    startRangeMs: [150, 150] as [number, number],
  };
  const source = {
    ...model,
    currentOccurrences: occurrences,
    recordingTimelineForPath: (file: string) => ({
      timeline:
        file === path
          ? { ...timeline, markers: [firstMarker] }
          : { ...timeline, videoPath: 'videos/second.mp4', markers: [secondMarker] },
      current: true,
    }),
    markerSeekMs(file: string, traceIndex: number) {
      seeks.push([file, traceIndex]);
      return file === videoPath ? 50 : 150;
    },
  };
  const first = evidenceReviewerTimeline(source, path);
  const initialReads = traceReads;
  const second = evidenceReviewerTimeline(source, secondPath);
  assert.equal(traceReads, initialReads, 'rotating did not reread or reorder the occurrence data');
  assert.equal(first?.stepCount, 60);
  assert.equal(second?.stepCount, 60);
  assert.deepEqual(seeks, []);
  assert.deepEqual(
    first?.page(25, 3).map((row) => [row.traceIndex, row.atMs]),
    [
      [25, null],
      [26, 50],
      [27, null],
    ],
  );
  assert.deepEqual(
    second?.page(25, 3).map((row) => [row.traceIndex, row.atMs]),
    [
      [25, null],
      [26, 150],
      [27, null],
    ],
  );
  assert.deepEqual(seeks, [
    [videoPath, 26],
    ['videos/second.mp4', 26],
  ]);
});
