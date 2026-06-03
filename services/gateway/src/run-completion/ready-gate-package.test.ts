import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  computeReadyGatePackageHash,
  computeReadyGatePackageInputHash,
  computeReadyGateReviewSubjectHash,
  verifyReadyGatePackageHash,
  verifyReadyGateSelectedEvidenceFiles,
} from './ready-gate-package.js';
import { makeRun } from './test-fixtures.js';

test('ready package hashes separate artifact identity from review subject', () => {
  const base = {
    id: 'pkg-a',
    artifactPath: 'artifacts/pr-package.json',
    branch: 'fix/a',
    remoteBranchRef: 'origin/fix/a',
    headSha: 'abc1234',
    diffStat: { files: 1, additions: 2, deletions: 0 },
    draftTitle: 'fix: a',
    draftBody: 'body',
    evidenceManifest: [
      {
        path: 'artifacts/after.png',
        purpose: 'screenshot',
        sizeBytes: 3,
        sha256: 'evidence-a',
      },
    ],
    selectedEvidenceKeys: ['artifacts/after.png'],
    validationSummaryPath: 'artifacts/report.md',
    validationSummaryHash: 'validation-a',
    reviewArtifactIds: ['review-1'],
    dispatchMode: 'interactive' as const,
    gatePolicy: {
      owner: 'human' as const,
      dispatchMode: 'interactive' as const,
      publishAuthority: 'human' as const,
      reason: 'test',
    },
    reviewDepth: {
      minimumIndependentReviews: 1,
      requireCrossRunner: false,
      extraLoopsRequested: 0,
      requestedBy: 'dispatch' as const,
    },
    publicationTarget: 'ready' as const,
    publicationStatus: 'not_published' as const,
    createdAt: '2026-04-15T00:00:00.000Z',
  };
  const volatile = {
    ...base,
    id: 'pkg-b',
    createdAt: '2026-04-15T00:01:00.000Z',
    selectedEvidenceKeys: [],
    publicationTarget: 'draft' as const,
  };
  assert.notEqual(computeReadyGatePackageHash(base), computeReadyGatePackageHash(volatile));
  assert.notEqual(
    computeReadyGatePackageInputHash(base),
    computeReadyGatePackageInputHash(volatile),
  );
  assert.notEqual(
    computeReadyGateReviewSubjectHash(base),
    computeReadyGateReviewSubjectHash(volatile),
  );
  assert.notEqual(
    computeReadyGateReviewSubjectHash(base),
    computeReadyGateReviewSubjectHash({ ...base, headSha: 'def5678' }),
  );
  assert.notEqual(
    computeReadyGateReviewSubjectHash(base),
    computeReadyGateReviewSubjectHash({
      ...base,
      evidenceManifest: [{ ...base.evidenceManifest[0], sha256: 'evidence-b' }],
    }),
  );
  assert.equal(
    computeReadyGateReviewSubjectHash(base),
    computeReadyGateReviewSubjectHash({
      ...base,
      evidenceManifest: [
        ...base.evidenceManifest,
        { path: 'artifacts/unselected-log.json', purpose: 'other', sizeBytes: 99 },
      ],
    }),
  );
  assert.equal(
    computeReadyGateReviewSubjectHash(base),
    computeReadyGateReviewSubjectHash({
      ...base,
      reviewArtifactIds: ['review-2'],
      reviewDepth: {
        minimumIndependentReviews: 1,
        requireCrossRunner: true,
        extraLoopsRequested: 2,
        requestedBy: 'human-gate' as const,
      },
      gatePolicy: {
        owner: 'agent' as const,
        dispatchMode: 'autonomous' as const,
        publishAuthority: 'human' as const,
        reason: 'policy metadata changed',
      },
    }),
  );
  const packageInputHash = computeReadyGatePackageInputHash(base);
  const reviewSubjectHash = computeReadyGateReviewSubjectHash(base);
  assert.equal(
    computeReadyGatePackageInputHash({ ...base, packageInputHash, reviewSubjectHash }),
    packageInputHash,
  );
  assert.equal(
    computeReadyGateReviewSubjectHash({ ...base, packageInputHash, reviewSubjectHash }),
    reviewSubjectHash,
  );

  const packageHash = computeReadyGatePackageHash(base);
  assert.doesNotThrow(() => verifyReadyGatePackageHash({ ...base, packageHash }));
  assert.throws(
    () => verifyReadyGatePackageHash({ ...base, packageHash: 'tampered' }),
    /package hash mismatch/i,
  );
});

test('ready gate selected evidence checks and review hash use path variants', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-selected-evidence-variants-'));
  try {
    const artifactsDir = path.join(root, 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    const taskFile = path.join(root, 'task.md');
    const imageBytes = Buffer.from('image-a');
    await writeFile(taskFile, '# Task\n');
    await writeFile(path.join(artifactsDir, 'after-ac1.png'), imageBytes);
    const sha256 = createHash('sha256').update(imageBytes).digest('hex');
    const basePackage = {
      id: 'pkg-variants',
      artifactPath: 'artifacts/pr-package.json',
      branch: 'feature/pkg-variants',
      headSha: 'abc123',
      diffStat: { files: 1, additions: 1, deletions: 0 },
      draftTitle: 'feat: implement PROJ-1',
      draftBody: 'body',
      evidenceManifest: [
        {
          path: 'artifacts/after-ac1.png',
          purpose: 'screenshot',
          sizeBytes: imageBytes.length,
          sha256,
        },
        {
          path: 'artifacts/unselected.png',
          purpose: 'screenshot',
          sizeBytes: 1,
        },
      ],
      selectedEvidenceKeys: ['after-ac1.png'],
      validationSummaryPath: null,
      validationSummaryHash: null,
      reviewArtifactIds: [],
      dispatchMode: 'autonomous' as const,
      gatePolicy: { owner: 'human' as const, publishAuthority: 'human' as const, reason: 'test' },
      publicationTarget: 'ready' as const,
      publicationStatus: 'not_published' as const,
      createdAt: '2026-05-18T00:00:00.000Z',
    };
    const reviewHash = computeReadyGateReviewSubjectHash(basePackage);
    const reviewHashCanonical = computeReadyGateReviewSubjectHash({
      ...basePackage,
      selectedEvidenceKeys: ['artifacts/after-ac1.png'],
    });
    assert.equal(reviewHash, reviewHashCanonical);

    const packageInputHash = computeReadyGatePackageInputHash(basePackage);
    const packageHash = computeReadyGatePackageHash({
      ...basePackage,
      packageInputHash,
      reviewSubjectHash: reviewHash,
    });
    await verifyReadyGateSelectedEvidenceFiles(
      makeRun({ taskFile }),
      { ...basePackage, packageInputHash, reviewSubjectHash: reviewHash, packageHash },
      ['./after-ac1.png'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
