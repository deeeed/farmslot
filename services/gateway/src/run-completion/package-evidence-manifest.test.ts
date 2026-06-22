import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArtifactRef } from '@farmslot/protocol';

import { buildPackageEvidenceManifest } from './package-evidence-manifest.js';

test('buildPackageEvidenceManifest honors curated explicit publish set and omissions', async () => {
  const artifacts: ArtifactRef[] = [
    { path: 'artifacts/before-ac1.png', purpose: 'screenshot' },
    { path: 'artifacts/after-ac1.png', purpose: 'screenshot' },
    { path: 'artifacts/evidence-extra.png', purpose: 'screenshot' },
    { path: 'artifacts/debug.png', purpose: 'screenshot' },
    { path: 'artifacts/pr-package.json', purpose: 'package' },
  ];

  const manifest = await buildPackageEvidenceManifest(null, artifacts, {
    version: 1,
    preferred_mode: 'screenshots',
    before_after_pairs: [{ label: 'AC1', before: 'before-ac1.png', after: 'after-ac1.png' }],
    standalone: [{ label: 'Curated', file: 'evidence-selected.png' }],
    omit: [{ file: 'debug.png', reason: 'debug-only' }],
  });

  assert.deepEqual(
    manifest.map((artifact) => artifact.path),
    ['artifacts/after-ac1.png', 'artifacts/before-ac1.png', 'artifacts/evidence-selected.png'],
  );
});

test('buildPackageEvidenceManifest keeps only publishable or manifest-referenced evidence', async () => {
  const artifacts: ArtifactRef[] = [
    { path: 'artifacts/report.md', purpose: 'report' },
    { path: 'artifacts/runtime-launch/chrome-profile/Local State', purpose: 'other' },
    { path: 'artifacts/runtime-launch/runtime-dist/app.js', purpose: 'script' },
    { path: 'artifacts/recipe-run/ac1.png', purpose: 'screenshot' },
    { path: 'artifacts/recipe-run/debug-extra.png', purpose: 'screenshot' },
  ];

  const manifest = await buildPackageEvidenceManifest(null, artifacts, {
    version: 1,
    preferred_mode: 'screenshots',
    before_after_pairs: [],
    standalone: [
      { label: 'AC1', file: 'recipe-run/ac1.png' },
    ],
    omit: [],
  });

  assert.deepEqual(
    manifest.map((artifact) => artifact.path),
    ['artifacts/recipe-run/ac1.png'],
  );
});
