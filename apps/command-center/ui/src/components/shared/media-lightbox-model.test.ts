import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  isImageLightboxItem,
  isVideoLightboxItem,
  mediaLightboxFileType,
  mediaLightboxFileTypeBadge,
} from './media-lightbox-model.js';

test('media lightbox file type detection keeps purpose and extension behavior', () => {
  assert.equal(mediaLightboxFileType({ path: 'shots/home.png', purpose: 'artifact' }), 'image');
  assert.equal(mediaLightboxFileType({ path: 'trace.bin', purpose: 'screenshot' }), 'image');
  assert.equal(mediaLightboxFileType({ path: 'clips/demo.webm', purpose: 'artifact' }), 'video');
  assert.equal(mediaLightboxFileType({ path: 'trace.bin', purpose: 'video-before' }), 'video');
  assert.equal(mediaLightboxFileType({ path: 'notes.md', purpose: 'artifact' }), 'markdown');
  assert.equal(mediaLightboxFileType({ path: 'payload.json', purpose: 'artifact' }), 'json');
  assert.equal(mediaLightboxFileType({ path: 'diff.txt', purpose: 'artifact' }), 'diff');
  assert.equal(mediaLightboxFileType({ path: 'log.txt', purpose: 'stdout-diff' }), 'diff');
  assert.equal(mediaLightboxFileType({ path: 'archive.zip', purpose: 'artifact' }), 'file');
});

test('media lightbox type badges match existing UI labels', () => {
  assert.equal(mediaLightboxFileTypeBadge('image'), 'IMAGE');
  assert.equal(mediaLightboxFileTypeBadge('video'), 'VIDEO');
  assert.equal(mediaLightboxFileTypeBadge('markdown'), 'MD');
  assert.equal(mediaLightboxFileTypeBadge('json'), 'JSON');
  assert.equal(mediaLightboxFileTypeBadge('diff'), 'DIFF');
  assert.equal(mediaLightboxFileTypeBadge('file'), 'FILE');
});

test('media lightbox media predicates mirror file type shortcuts', () => {
  assert.equal(isImageLightboxItem({ path: 'image.gif', purpose: 'artifact' }), true);
  assert.equal(isVideoLightboxItem({ path: 'movie.mov', purpose: 'artifact' }), true);
  assert.equal(isImageLightboxItem({ path: 'notes.md', purpose: 'artifact' }), false);
  assert.equal(isVideoLightboxItem({ path: 'notes.md', purpose: 'artifact' }), false);
});
