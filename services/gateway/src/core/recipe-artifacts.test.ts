import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inferArtifactPurpose,
  inferTypedArtifactPurpose,
  sanitizeLatestValidRecipeRunPointer,
} from './recipe-artifacts.js';

test('inferArtifactPurpose keeps before/after screenshots classified as screenshots', () => {
  assert.equal(inferArtifactPurpose('before.png'), 'screenshot');
  assert.equal(inferArtifactPurpose('nested/after.jpeg'), 'screenshot');
  assert.equal(inferArtifactPurpose('anim.gif'), 'screenshot');
  assert.equal(inferArtifactPurpose('evidence/baseline.png'), 'screenshot');
});

test('inferArtifactPurpose demotes raw recipe-runner spool under screenshots/ to debug-screenshot', () => {
  assert.equal(
    inferArtifactPurpose('screenshots/evidence-ac1-1777432413815.png'),
    'debug-screenshot',
  );
  assert.equal(inferArtifactPurpose('screenshots/foo.jpeg'), 'debug-screenshot');
});

test('inferArtifactPurpose keeps before/after videos classified as directional videos', () => {
  assert.equal(inferArtifactPurpose('before.mp4'), 'video-before');
  assert.equal(inferArtifactPurpose('nested/after.mov'), 'video-after');
  assert.equal(inferArtifactPurpose('nested/after.webm'), 'video-after');
});

test('inferArtifactPurpose classifies bundled recipe dependencies separately from generic json', () => {
  assert.equal(
    inferArtifactPurpose('recipe-library/recipes/demo/login.recipe.json'),
    'recipe-library',
  );
  assert.equal(inferArtifactPurpose('trace.json'), 'other');
});

test('inferArtifactPurpose classifies the typed artifact manifest as runner definition metadata', () => {
  assert.equal(inferArtifactPurpose('artifact-manifest.json'), 'artifact-manifest');
});

test('inferTypedArtifactPurpose maps core typed artifacts while preserving video direction', () => {
  assert.equal(inferTypedArtifactPurpose('screenshot', 'screenshots/proof.png'), 'screenshot');
  assert.equal(inferTypedArtifactPurpose('video', 'before.webm'), 'video-before');
  assert.equal(inferTypedArtifactPurpose('video', 'capture.webm'), 'video');
  assert.equal(inferTypedArtifactPurpose('trace', 'trace.json'), 'trace');
  assert.equal(inferTypedArtifactPurpose('unknown-plugin-type', 'custom.bin'), 'other');
});

test('inferArtifactPurpose classifies publication package artifacts explicitly', () => {
  assert.equal(inferArtifactPurpose('pr-package.json'), 'pr-package-json');
  assert.equal(inferArtifactPurpose('pr-package.md'), 'pr-package-md');
});

test('sanitizeLatestValidRecipeRunPointer normalizes current-directory segments', () => {
  const pointer = sanitizeLatestValidRecipeRunPointer({
    version: 1,
    runId: 'stale-run-id',
    relativeArtifactRoot: 'recipe-runs/./passing-run',
  });
  assert.deepEqual(pointer, {
    version: 1,
    runId: 'passing-run',
    relativeArtifactRoot: 'recipe-runs/passing-run',
  });
});

test('sanitizeLatestValidRecipeRunPointer rejects parent traversal after normalization', () => {
  const pointer = sanitizeLatestValidRecipeRunPointer({
    version: 1,
    runId: 'bad',
    relativeArtifactRoot: 'recipe-runs/../outside',
  });
  assert.equal(pointer, null);
});

test('sanitizeLatestValidRecipeRunPointer normalizes backslashes before validation', () => {
  const pointer = sanitizeLatestValidRecipeRunPointer({
    version: 1,
    runId: 'ignored',
    relativeArtifactRoot: 'recipe-runs\\windows-run',
  });
  assert.deepEqual(pointer, {
    version: 1,
    runId: 'windows-run',
    relativeArtifactRoot: 'recipe-runs/windows-run',
  });
});

test('sanitizeLatestValidRecipeRunPointer rejects normalized nested traversal escapes', () => {
  const pointer = sanitizeLatestValidRecipeRunPointer({
    version: 1,
    runId: 'ignored',
    relativeArtifactRoot: 'recipe-runs/x/../../etc',
  });
  assert.equal(pointer, null);
});
