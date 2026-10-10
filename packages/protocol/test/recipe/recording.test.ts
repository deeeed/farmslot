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

test('video interruptions accept unavailable counts and measured frames with a zero or fractional media time', () => {
  for (const [frames, mediaTimeMs] of [
    [0, 0],
    [1, 0],
    [12, 803.5],
  ]) {
    assert.equal(
      validateArtifactManifestDocument({
        version: 1,
        artifacts: [
          {
            path: 'run.mp4',
            type: 'video',
            interruption: { frames, mediaTimeMs, cause: 'The recording stream stopped.' },
          },
        ],
      }).status,
      'valid',
    );
  }
});

test('interruptions must be objects attached to videos', () => {
  for (const interruption of [null, 'stopped', false, 1, []]) {
    const result = validateArtifactManifestDocument({
      version: 1,
      artifacts: [{ path: 'run.mp4', type: 'video', interruption }],
    });
    assert.equal(result.status, 'invalid');
    assert.equal(result.findings[0]?.code, 'artifact_manifest.invalid_interruption');
    assert.equal(result.findings[0]?.path, 'artifacts[0].interruption');
  }
  const result = validateArtifactManifestDocument({
    version: 1,
    artifacts: [
      {
        path: 'screenshot.png',
        type: 'screenshot',
        interruption: { frames: 1, mediaTimeMs: 0, cause: 'The recording stream stopped.' },
      },
    ],
  });
  assert.equal(result.status, 'invalid');
  assert.equal(result.findings[0]?.path, 'artifacts[0].interruption');
});

test('interruptions reject malformed frame counts, media times and causes', () => {
  const validInterruption = { frames: 12, mediaTimeMs: 803.5, cause: 'The stream stopped.' };
  const invalidValues = {
    frames: [undefined, '12', -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1],
    mediaTimeMs: [undefined, '803', -1, Number.NaN, Infinity],
    cause: [undefined, 1, '', '   '],
  };
  for (const [field, values] of Object.entries(invalidValues)) {
    for (const value of values) {
      const result = validateArtifactManifestDocument({
        version: 1,
        artifacts: [
          {
            path: 'run.mp4',
            type: 'video',
            interruption: { ...validInterruption, [field]: value },
          },
        ],
      });
      assert.equal(result.status, 'invalid', `${field}: ${String(value)}`);
      assert.deepEqual(
        result.findings.map(({ code, path }) => ({ code, path })),
        [
          {
            code: 'artifact_manifest.invalid_interruption_field',
            path: `artifacts[0].interruption.${field}`,
          },
        ],
      );
    }
  }
});
