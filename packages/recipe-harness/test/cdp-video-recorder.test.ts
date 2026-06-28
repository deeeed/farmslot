import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCdpVideoRecorder } from '../src/recording/cdp-video-recorder.js';

test('createCdpVideoRecorder exposes web cdp-screencast recorder metadata', () => {
  const recorder = createCdpVideoRecorder({ cdpPort: 9323, urlIncludes: '#fleet' });
  assert.equal(recorder.name, 'cdp-screencast');
  assert.equal(recorder.platform, 'web');
  assert.equal(typeof recorder.doctor, 'function');
  assert.equal(typeof recorder.start, 'function');
});