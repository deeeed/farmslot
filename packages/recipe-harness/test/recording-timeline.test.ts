import assert from 'node:assert/strict';
import test from 'node:test';

import { createRecordingTimeline } from '../src/recording/timeline.js';

test('trace markers preserve repeated composed nodes and events outside footage', () => {
  const trace = [950, 1200].map((time) => ({
    nodeId: 'journey/open/assert',
    action: 'assert',
    proves: ['AC1'],
    ok: true,
    startedAt: new Date(time).toISOString(),
    endedAt: new Date(time + 10).toISOString(),
    durationMs: 10,
  }));
  const timeline = createRecordingTimeline(
    'run.mp4',
    `sha256:${'a'.repeat(64)}`,
    {
      framesMs: [0, 31, 151, 299],
      durationMs: 310,
      clock: { source: 'measured-test-clock', earliestZeroUnixMs: 1000, latestZeroUnixMs: 1020 },
    },
    trace,
  );
  assert.deepEqual(
    timeline.markers.map((marker) => marker.traceIndex),
    [0, 1],
  );
  assert.deepEqual(timeline.markers[0]!.startRangeMs, [-70, -50]);
  assert.deepEqual(timeline.markers[1]!.startRangeMs, [180, 200]);
  assert.deepEqual(timeline.framesMs, [0, 31, 151, 299]);
  assert.equal(timeline.markers[1]!.nodeId, 'journey/open/assert');
  const otherAttempt = createRecordingTimeline(
    'run.mp4',
    `sha256:${'b'.repeat(64)}`,
    timeline,
    trace,
  );
  assert.notEqual(otherAttempt.videoDigest, timeline.videoDigest);
});
