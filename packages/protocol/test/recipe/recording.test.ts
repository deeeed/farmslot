import assert from 'node:assert/strict';
import test from 'node:test';

import { validateArtifactManifestDocument } from '../../src/recipe/artifact.js';
import { validateRecipeRecordingTimelineDocument } from '../../src/recipe/recording.js';

const timeline = {
  version: 1,
  videoPath: 'run.mp4',
  videoDigest: `sha256:${'a'.repeat(64)}`,
  traceDigest: `sha256:${'b'.repeat(64)}`,
  framesMs: [0, 27, 803],
  durationMs: 900,
  clock: { source: 'recorder-lifetime-bound', earliestZeroUnixMs: 1000, latestZeroUnixMs: 1020 },
  markers: [
    {
      traceIndex: 0,
      nodeId: 'journey/nested/assert',
      action: 'assert',
      ok: true,
      proves: ['AC1'],
      startRangeMs: [750, 770],
      endRangeMs: [800, 820],
    },
  ],
};

test('optional timelines preserve variable frames, nested nodes and uncertainty', () => {
  assert.equal(validateRecipeRecordingTimelineDocument(timeline).status, 'valid');
  assert.equal(
    validateArtifactManifestDocument({
      version: 1,
      artifacts: [{ path: 'run.mp4', type: 'video' }],
    }).status,
    'valid',
  );
  assert.equal(
    validateArtifactManifestDocument({
      version: 1,
      artifacts: [{ path: 'run.mp4', type: 'video', timelinePath: '../escape.json' }],
    }).status,
    'invalid',
  );
});

test('timelines reject unbound, ambiguous and malformed timing', () => {
  for (const patch of [
    { framesMs: [0, 803, 27] },
    { framesMs: [0, 27, 27] },
    { framesMs: [0, Number.NaN] },
    { durationMs: 700 },
    { videoPath: '../run.mp4' },
    { videoDigest: 'unknown' },
    { clock: { ...timeline.clock, latestZeroUnixMs: 999 } },
    { markers: [...timeline.markers, timeline.markers[0]] },
    { markers: [{ ...timeline.markers[0], startRangeMs: [20, 10] }] },
  ])
    assert.equal(
      validateRecipeRecordingTimelineDocument({ ...timeline, ...patch }).status,
      'invalid',
      JSON.stringify(patch),
    );
});
