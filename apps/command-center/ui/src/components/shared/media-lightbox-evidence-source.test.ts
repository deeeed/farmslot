import assert from 'node:assert/strict';
import test from 'node:test';

import { digestRecipeDocument } from '@farmslot/protocol';

import { loadLightboxEvidence } from './media-lightbox-evidence-source.js';

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
  assert.deepEqual((await loadLightboxEvidence(item, read)).recordings[0], timeline);
  await assert.rejects(
    loadLightboxEvidence({ ...item, sha256: 'b'.repeat(64) }, read),
    /different video/,
  );
  timeline.markers[0]!.startRangeMs = [120, 130];
  await assert.rejects(
    loadLightboxEvidence(item, async (path) =>
      path.endsWith('trace.json')
        ? [entry]
        : {
            ...timeline,
            markers: [{ ...timeline.markers[0], intent: 'Invented proof title' }],
          },
    ),
    /does not match/,
  );
  await assert.rejects(loadLightboxEvidence(item, read), /marker time/);
});
