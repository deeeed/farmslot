import assert from 'node:assert/strict';
import test from 'node:test';

import {
  artifactScanFilters,
  extractEvidenceManifestReferencedPaths,
  normalizeArtifactRelativePath,
  shouldIncludeArtifactFile,
  shouldSkipArtifactName,
  shouldVisitArtifactDirectory,
} from './artifact-filters.js';

test('normalizeArtifactRelativePath accepts artifact-root-relative paths only', () => {
  assert.equal(normalizeArtifactRelativePath('screenshots/proof.png'), 'screenshots/proof.png');
  assert.equal(normalizeArtifactRelativePath('./screenshots/proof.png'), 'screenshots/proof.png');
  assert.equal(
    normalizeArtifactRelativePath('artifacts/screenshots/proof.png'),
    'screenshots/proof.png',
  );
  assert.equal(normalizeArtifactRelativePath('screenshots\\proof.png'), 'screenshots/proof.png');
  assert.equal(normalizeArtifactRelativePath('../outside.png'), null);
  assert.equal(normalizeArtifactRelativePath('/tmp/proof.png'), null);
  assert.equal(normalizeArtifactRelativePath('screenshots/../proof.png'), null);
  assert.equal(normalizeArtifactRelativePath(''), null);
});

test('extractEvidenceManifestReferencedPaths collects supported evidence manifest paths', () => {
  const refs = extractEvidenceManifestReferencedPaths(
    JSON.stringify({
      before_after_pairs: [
        { before: 'screenshots/before.png', after: 'artifacts/screenshots/after.png' },
        { before: '../outside.png', after: null },
      ],
      standalone: [{ file: './logs/pass.log' }],
      videos: {
        preferred: 'ignored-key.mp4',
        note: 'ignored-note',
        demo: 'videos/demo.webm',
      },
    }),
    'evidence-manifest.json',
  );

  assert.deepEqual(refs, [
    'screenshots/before.png',
    'screenshots/after.png',
    'logs/pass.log',
    'videos/demo.webm',
  ]);
});

test('artifact scan filters skip hidden files and allow referenced files under excluded roots', () => {
  const { excludedTopLevel, includedRelativePaths } = artifactScanFilters({
    excludeTopLevel: ['screenshots'],
    includeRelativePaths: ['screenshots/after.png', '../outside.png'],
  });

  assert.equal(shouldSkipArtifactName('.DS_Store'), true);
  assert.equal(shouldSkipArtifactName('.omc'), true);
  assert.equal(shouldSkipArtifactName('summary.json'), false);
  assert.equal(
    shouldIncludeArtifactFile('summary.json', excludedTopLevel, includedRelativePaths),
    true,
  );
  assert.equal(
    shouldIncludeArtifactFile('screenshots/raw.png', excludedTopLevel, includedRelativePaths),
    false,
  );
  assert.equal(
    shouldIncludeArtifactFile('screenshots/after.png', excludedTopLevel, includedRelativePaths),
    true,
  );
  assert.equal(
    shouldVisitArtifactDirectory('screenshots', excludedTopLevel, includedRelativePaths),
    true,
  );
  assert.equal(
    shouldVisitArtifactDirectory('screenshots/debug', excludedTopLevel, includedRelativePaths),
    false,
  );
});
