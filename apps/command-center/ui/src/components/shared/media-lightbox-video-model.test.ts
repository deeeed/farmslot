import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_VIDEO_FRAME_RATE,
  mediaLightboxFrameRateForSelection,
  mediaLightboxFrameStepSeconds,
} from './media-lightbox-video-model.js';

test('media lightbox video frame step uses artifact frame rate when present', () => {
  assert.equal(
    mediaLightboxFrameRateForSelection({
      mode: 'single',
      item: { url: '/proof.mp4', path: 'proof.mp4', purpose: 'video', frameRate: 10 },
    }),
    10,
  );
  assert.equal(mediaLightboxFrameStepSeconds(1, 10), 0.1);
  assert.equal(mediaLightboxFrameStepSeconds(-1, 10), -0.1);
});

test('media lightbox video frame step falls back to default frame rate', () => {
  assert.equal(
    mediaLightboxFrameRateForSelection({
      mode: 'single',
      item: { url: '/proof.mp4', path: 'proof.mp4', purpose: 'video' },
    }),
    DEFAULT_VIDEO_FRAME_RATE,
  );
  assert.equal(mediaLightboxFrameStepSeconds(1, 0), 1 / DEFAULT_VIDEO_FRAME_RATE);
});

test('media lightbox compare frame rate prefers after video metadata', () => {
  assert.equal(
    mediaLightboxFrameRateForSelection({
      mode: 'compare',
      pair: {
        kind: 'video',
        stem: 'proof',
        before: { url: '/before.mp4', path: 'before.mp4', purpose: 'video-before', frameRate: 15 },
        after: { url: '/after.mp4', path: 'after.mp4', purpose: 'video-after', frameRate: 24 },
      },
    }),
    24,
  );
});
