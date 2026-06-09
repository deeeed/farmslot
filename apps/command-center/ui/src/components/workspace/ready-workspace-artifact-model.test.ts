import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReadyGatePayload } from '@farmslot/protocol';

import {
  readyWorkspaceAllArtifacts,
  readyWorkspaceEvidenceArtifacts,
  readyWorkspacePackagePreviewArtifact,
  readyWorkspacePrimaryDiffArtifact,
  readyWorkspacePublishEvidenceArtifacts,
  readyWorkspaceReviewArtifacts,
} from './ready-workspace-artifact-model.js';

function payload(overrides: Record<string, unknown>): ReadyGatePayload {
  return overrides as unknown as ReadyGatePayload;
}

test('ready workspace artifact model merges package, evidence, and review artifacts', () => {
  const artifacts = readyWorkspaceAllArtifacts(
    payload({
      artifactManifest: [
        { path: 'artifacts/diff.txt', purpose: 'diff' },
        { path: 'artifacts/after.png', purpose: 'screenshot' },
      ],
      independentReviews: [{ loopNumber: 2, artifactPaths: ['reviews/review.md'] }],
      prPackage: {
        artifactPath: 'artifacts/pr-package.json',
        validationSummaryPath: 'artifacts/validation.md',
        evidenceManifest: [{ path: 'artifacts/after.png', purpose: 'screenshot' }],
      },
    }),
  );

  assert.deepEqual(
    artifacts.map((artifact) => [artifact.path, artifact.purpose]),
    [
      ['artifacts/diff.txt', 'diff'],
      ['artifacts/after.png', 'screenshot'],
      ['reviews/review.md', 'review-loop-2'],
      ['artifacts/pr-package.json', 'pr-package-json'],
      ['artifacts/pr-package.md', 'pr-package-md'],
      ['artifacts/validation.md', 'validation-summary'],
    ],
  );
});

test('ready workspace evidence model keeps publish selection media-only', () => {
  const input = payload({
    artifactManifest: [
      { path: 'artifacts/after.png', purpose: 'screenshot' },
      { path: 'artifacts/raw.json', purpose: 'debug-json' },
    ],
    prPackage: {
      selectedEvidenceKeys: ['artifacts/raw.json'],
    },
  });

  assert.deepEqual(
    readyWorkspacePublishEvidenceArtifacts(input).map((artifact) => artifact.path),
    ['artifacts/after.png'],
  );
  assert.deepEqual(
    readyWorkspaceEvidenceArtifacts(input).map((artifact) => artifact.path),
    ['artifacts/after.png'],
  );
});

test('ready workspace evidence model preserves selected package media under screenshots paths', () => {
  const input = payload({
    prPackage: {
      evidenceManifest: [
        { path: 'artifacts/screenshots/manifest-proof.png', purpose: 'screenshot' },
        { path: 'artifacts/recipe-capture-helper.json', purpose: 'json' },
        { path: 'artifacts/after-capture-helper.log', purpose: 'log' },
      ],
      selectedEvidenceKeys: [
        'screenshots/manifest-proof.png',
        'artifacts/recipe-capture-helper.json',
        'artifacts/after-capture-helper.log',
      ],
    },
  });

  assert.deepEqual(
    readyWorkspacePublishEvidenceArtifacts(input).map((artifact) => artifact.path),
    ['artifacts/screenshots/manifest-proof.png'],
  );
  assert.deepEqual(
    readyWorkspaceEvidenceArtifacts(input).map((artifact) => artifact.path),
    ['artifacts/screenshots/manifest-proof.png'],
  );
});

test('ready workspace artifact model exposes review, package preview, and diff helpers', () => {
  const input = payload({
    artifactManifest: [{ path: 'reports/changes.diff', purpose: 'review patch' }],
    independentReviews: [
      { loopNumber: 1, artifactPaths: ['reviews/notes.md', 'reviews/diff.txt'] },
    ],
    prPackage: { artifactPath: 'artifacts/pr-package.json' },
  });

  assert.deepEqual(
    readyWorkspaceReviewArtifacts(input).map((artifact) => artifact.purpose),
    ['review-loop-1', 'review-loop-1'],
  );
  assert.deepEqual(readyWorkspacePackagePreviewArtifact(input), {
    path: 'artifacts/pr-package.md',
    purpose: 'pr-package-md',
  });
  assert.equal(readyWorkspacePrimaryDiffArtifact(input)?.path, 'reports/changes.diff');
});
