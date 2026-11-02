import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArtifactRef } from '@farmslot/protocol';

import { artifactLightboxItems, artifactLightboxPairs } from './artifact-lightbox-model.js';

test('artifactLightboxItems maps included artifacts to media-lightbox items', () => {
  const artifacts = [
    { path: 'artifacts/after.png', purpose: 'screenshot' },
    { path: 'artifacts/report.txt', purpose: 'log' },
  ];

  assert.deepEqual(
    artifactLightboxItems(
      artifacts,
      (artifact) => `/artifact/${artifact.path}`,
      (artifact) => artifact.purpose === 'screenshot',
    ),
    [{ url: '/artifact/artifacts/after.png', path: 'artifacts/after.png', purpose: 'screenshot' }],
  );
});

test('unbound videos stay playable without filename-derived pairs', () => {
  const artifacts = [
    { path: 'artifacts/ac1-before.mp4', purpose: 'video-before' },
    { path: 'artifacts/ac1-after.mp4', purpose: 'video-after' },
    { path: 'artifacts/summary.md', purpose: 'summary' },
  ];

  assert.deepEqual(
    artifactLightboxPairs(
      artifacts,
      (artifact) => `/artifact/${artifact.path}`,
      (artifact) => artifact.purpose.startsWith('video'),
      (artifact) => artifact.path.endsWith('.mp4'),
    ),
    [],
  );
  assert.deepEqual(
    artifactLightboxItems(
      artifacts,
      (artifact) => `/artifact/${artifact.path}`,
      (artifact) => artifact.path.endsWith('.mp4'),
    ).map((item) => item.path),
    ['artifacts/ac1-before.mp4', 'artifacts/ac1-after.mp4'],
  );
});

test('an HTML file can resolve report media without reusing the document digest', () => {
  const artifact: ArtifactRef = {
    path: 'artifacts/report.html',
    purpose: 'report',
    sha256: 'a'.repeat(64),
    bundleDigest: 'retained-bundle',
  };
  const seen: ArtifactRef[] = [];
  const [report] = artifactLightboxItems(
    [artifact],
    (file) => {
      seen.push(file);
      return file.path;
    },
    () => true,
  );
  assert.ok(report);
  assert.equal(
    report.resolveArtifactUrl?.('artifacts/case-1/videos/recipe-run.mp4'),
    'artifacts/case-1/videos/recipe-run.mp4',
  );
  assert.ok(seen[1]);
  assert.equal(seen[1].bundleDigest, 'retained-bundle');
  assert.equal(seen[1].sha256, undefined);
});
