import assert from 'node:assert/strict';
import test from 'node:test';

import { digestRecipeDocument, type RecipeRecordingMarker } from '@farmslot/protocol';

import {
  adjacentVideoFrameMs,
  displayedVideoFrameRangeMs,
  loadVideoTimeline,
  videoMarkerSeekMs,
} from './media-lightbox-video-model.js';

test('frame navigation uses measured variable timestamps and clamps at the ends', () => {
  const frames = [0, 23, 140, 1700];
  assert.equal(adjacentVideoFrameMs(frames, 23, 1), 140);
  assert.equal(adjacentVideoFrameMs(frames, 500, -1), 23);
  assert.equal(adjacentVideoFrameMs(frames, 0, -1), 0);
  assert.equal(adjacentVideoFrameMs(frames, 1700, 1), 1700);
  assert.equal(adjacentVideoFrameMs([], 0, 1), null);
  assert.deepEqual(displayedVideoFrameRangeMs(frames, 1800, 500), [140, 1700]);
  assert.equal(displayedVideoFrameRangeMs(frames, 1800, 1801), null);
});

test('marker labels and seeks clamp crossing clock windows to the first and final frame', () => {
  const timing = {
    framesMs: [23, 140, 1700],
    durationMs: 1800,
    clock: { source: 'observed', earliestZeroUnixMs: 1000, latestZeroUnixMs: 1010 },
  };
  const marker: RecipeRecordingMarker = {
    traceIndex: 0,
    nodeId: 'press',
    action: 'ui.press',
    ok: true,
    startRangeMs: [-100, 40],
    endRangeMs: [1500, 2600],
  };
  assert.equal(videoMarkerSeekMs(timing, marker, 'start'), 23);
  assert.equal(videoMarkerSeekMs(timing, marker, 'end'), 1700);
  assert.deepEqual(marker.startRangeMs, [-100, 40]);
  assert.deepEqual(marker.endRangeMs, [1500, 2600]);
  assert.deepEqual(
    displayedVideoFrameRangeMs(timing.framesMs, timing.durationMs, 1700),
    [1700, 1800],
  );
});

test('markers wholly outside footage stay unrecorded, including the exclusive duration bound', () => {
  const timing = {
    framesMs: [23, 140, 1700],
    durationMs: 1800,
    clock: { source: 'observed', earliestZeroUnixMs: 1000, latestZeroUnixMs: 1010 },
  };
  const marker: RecipeRecordingMarker = {
    traceIndex: 0,
    nodeId: 'press',
    action: 'ui.press',
    ok: true,
    startRangeMs: [-20, 22],
    endRangeMs: [1800, 2100],
  };
  assert.equal(videoMarkerSeekMs(timing, marker, 'start'), null);
  assert.equal(videoMarkerSeekMs(timing, marker, 'end'), null);
  assert.equal(videoMarkerSeekMs(timing, { ...marker, startRangeMs: [23, 23] }, 'start'), 23);
  assert.equal(videoMarkerSeekMs(timing, { ...marker, endRangeMs: [1790, 1795] }, 'end'), 1700);
  assert.equal(videoMarkerSeekMs(timing, { ...marker, startRangeMs: [85, 100] }, 'start'), 92.5);
  assert.equal(videoMarkerSeekMs({ ...timing, framesMs: [] }, marker, 'start'), null);
});

test('a partial video uses its loaded media duration when native timing retains a longer tail', () => {
  const timing = {
    framesMs: [0, 33, 545],
    durationMs: 865,
    clock: { source: 'coremedia-host-clock', earliestZeroUnixMs: 1000, latestZeroUnixMs: 1001 },
  };
  const marker: RecipeRecordingMarker = {
    traceIndex: 0,
    nodeId: 'after-stop',
    action: 'wait',
    ok: true,
    startRangeMs: [600, 601],
    endRangeMs: [650, 651],
  };
  assert.equal(videoMarkerSeekMs(timing, marker, 'start', 580), null);
  assert.equal(videoMarkerSeekMs(timing, marker, 'end', 580), null);
  assert.equal(videoMarkerSeekMs(timing, { ...marker, endRangeMs: [550, 650] }, 'end', 580), 545);
  assert.deepEqual(displayedVideoFrameRangeMs(timing.framesMs, 580, 545), [545, 580]);
});

test('timeline must bind to current video bytes and unchanged trace semantics', async () => {
  const entry = {
    nodeId: 'child/press',
    action: 'ui.press',
    ok: true,
    startedAt: new Date(1100).toISOString(),
    endedAt: new Date(1250).toISOString(),
  };
  const timeline = {
    version: 1,
    videoPath: 'videos/run.mp4',
    videoDigest: `sha256:${'a'.repeat(64)}`,
    traceDigest: digestRecipeDocument([entry]),
    framesMs: [0, 23, 140],
    durationMs: 200,
    clock: { source: 'observed', earliestZeroUnixMs: 1000, latestZeroUnixMs: 1010 },
    markers: [
      {
        traceIndex: 0,
        nodeId: entry.nodeId,
        action: entry.action,
        ok: true,
        startRangeMs: [90, 100],
        endRangeMs: [240, 250],
      },
    ],
  };
  const item = {
    url: '/video',
    path: 'artifacts/case/videos/run.mp4',
    purpose: 'video',
    sha256: 'a'.repeat(64),
    timelinePath: 'artifacts/case/videos/run.mp4.timeline.json',
    resolveArtifactUrl: (path: string) => path,
  };
  const read = async (path: string) => (path.endsWith('trace.json') ? [entry] : timeline);
  assert.deepEqual(await loadVideoTimeline(item, read), timeline);
  await assert.rejects(
    loadVideoTimeline({ ...item, sha256: 'b'.repeat(64) }, read),
    /different video/,
  );
  timeline.markers[0]!.startRangeMs = [120, 130];
  await assert.rejects(
    loadVideoTimeline(item, async (path) =>
      path.endsWith('trace.json')
        ? [entry]
        : {
            ...timeline,
            markers: [{ ...timeline.markers[0], intent: 'Invented proof title' }],
          },
    ),
    /does not match/,
  );
  await assert.rejects(loadVideoTimeline(item, read), /marker time/);
});
