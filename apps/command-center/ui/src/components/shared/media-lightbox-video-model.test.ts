import assert from 'node:assert/strict';
import test from 'node:test';

import { digestRecipeDocument } from '@farmslot/protocol';

import {
  adjacentVideoFrameMs,
  displayedVideoFrameRangeMs,
  loadVideoTimeline,
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

test('timeline must bind to current video bytes and unchanged trace semantics', async () => {
  const entry = {
    nodeId: 'child/press',
    action: 'ui.press',
    ok: true,
    startedAt: new Date(1100).toISOString(),
    endedAt: new Date(1150).toISOString(),
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
        endRangeMs: [140, 150],
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
