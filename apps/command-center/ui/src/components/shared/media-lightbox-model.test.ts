import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createEvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import type { ArtifactRef } from '@farmslot/protocol';

import {
  isImageLightboxItem,
  isVideoLightboxItem,
  lightboxReportArtifactResolver,
  mediaLightboxFileType,
  mediaLightboxFileTypeBadge,
} from './media-lightbox-model.js';
import type { LightboxItem } from './media-lightbox-types.js';

test('a report-only gallery resolves videos from its retained inventory into the authenticated player', () => {
  const files: ArtifactRef[] = [
    { path: 'artifacts/report.html', purpose: 'report' },
    { path: 'artifacts/case-4-run/videos/recipe-run.mp4', purpose: 'video' },
  ];
  const model = createEvidenceReviewModel({
    context: 'run-detail',
    artifacts: files,
    report: { reportPath: files[0].path, manifestDigest: 'a'.repeat(64), artifactManifest: files },
  });
  const document: LightboxItem = {
    ...files[0],
    url: '/api/run-artifact?runId=run-1&path=artifacts%2Freport.html',
    evidenceModel: model,
    resolveArtifactUrl: (path) => {
      assert.equal(path, files[1].path);
      return '/api/run-artifact?runId=run-1&recipeRunId=recording-1&token=test-secret';
    },
  };
  const resolve = lightboxReportArtifactResolver(document, [document], 'https://cc.example/');
  const target = resolve('case-4-run/videos/recipe-run.mp4');
  assert.ok(target);
  assert.equal(
    target.viewUrl,
    'https://cc.example/#run/run-1?artifactRun=run-1&artifact=artifacts%2Fcase-4-run%2Fvideos%2Frecipe-run.mp4&recipeRun=recording-1',
  );
  assert.doesNotMatch(target.viewUrl, /test-secret|token=/);
  assert.equal(resolve('../private.mp4'), null);
  assert.equal(resolve('unknown/video.mp4'), null);

  // A family gallery can hold the same path from another run; the report keeps its own source.
  const other: LightboxItem = {
    ...files[1],
    url: '/api/run-artifact?runId=other-run',
    viewUrl: '#run/other-run',
  };
  assert.deepEqual(
    lightboxReportArtifactResolver(
      document,
      [document, other],
      'https://cc.example/',
    )('case-4-run/videos/recipe-run.mp4'),
    target,
  );
});

test('media lightbox file type detection keeps purpose and extension behavior', () => {
  assert.equal(mediaLightboxFileType({ path: 'shots/home.png', purpose: 'artifact' }), 'image');
  assert.equal(mediaLightboxFileType({ path: 'trace.bin', purpose: 'screenshot' }), 'image');
  assert.equal(mediaLightboxFileType({ path: 'clips/demo.webm', purpose: 'artifact' }), 'video');
  assert.equal(mediaLightboxFileType({ path: 'trace.bin', purpose: 'video-before' }), 'video');
  assert.equal(mediaLightboxFileType({ path: 'notes.md', purpose: 'artifact' }), 'markdown');
  assert.equal(mediaLightboxFileType({ path: 'report.html', purpose: 'report' }), 'html');
  assert.equal(mediaLightboxFileType({ path: 'standalone.HTM', purpose: 'artifact' }), 'html');
  assert.equal(mediaLightboxFileType({ path: 'payload.json', purpose: 'artifact' }), 'json');
  assert.equal(mediaLightboxFileType({ path: 'diff.txt', purpose: 'artifact' }), 'diff');
  assert.equal(mediaLightboxFileType({ path: 'log.txt', purpose: 'stdout-diff' }), 'diff');
  assert.equal(mediaLightboxFileType({ path: 'archive.zip', purpose: 'artifact' }), 'file');
});

test('media lightbox type badges match existing UI labels', () => {
  assert.equal(mediaLightboxFileTypeBadge('image'), 'IMAGE');
  assert.equal(mediaLightboxFileTypeBadge('video'), 'VIDEO');
  assert.equal(mediaLightboxFileTypeBadge('markdown'), 'MD');
  assert.equal(mediaLightboxFileTypeBadge('html'), 'HTML');
  assert.equal(mediaLightboxFileTypeBadge('json'), 'JSON');
  assert.equal(mediaLightboxFileTypeBadge('diff'), 'DIFF');
  assert.equal(mediaLightboxFileTypeBadge('file'), 'FILE');
});

test('media lightbox media predicates mirror file type shortcuts', () => {
  assert.equal(isImageLightboxItem({ path: 'image.gif', purpose: 'artifact' }), true);
  assert.equal(isImageLightboxItem({ path: 'stills/recorded-3.webp', purpose: 'artifact' }), true);
  assert.equal(isVideoLightboxItem({ path: 'movie.mov', purpose: 'artifact' }), true);
  assert.equal(isImageLightboxItem({ path: 'notes.md', purpose: 'artifact' }), false);
  assert.equal(isVideoLightboxItem({ path: 'notes.md', purpose: 'artifact' }), false);
});
