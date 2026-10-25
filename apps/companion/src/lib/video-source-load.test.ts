import assert from 'node:assert/strict';
import test from 'node:test';

import { gatewayResourceSource } from './gateway-http-auth';
import { videoSourceLoadDurationMs } from './video-source-load';

const uri = 'https://gateway.test/api/run-artifact?runId=run-a&path=video.mp4&bundleDigest=head';
const source = gatewayResourceSource(uri, { Authorization: 'Bearer service-test-credential' });

test('authenticated source metadata uses the URI actually delivered to the native player', () => {
  assert.notEqual(source.uri, uri, 'the legacy resource adapter adds its credential');
  const durationMs = videoSourceLoadDurationMs(source.uri, {
    videoSource: { uri: source.uri },
    duration: 106.56600189208984,
  });
  assert.ok(durationMs !== null);
  assert.ok(Math.abs(durationMs - 106566.0019) < 0.001);
  assert.equal(
    videoSourceLoadDurationMs(uri, { videoSource: { uri: source.uri }, duration: 106.566 }),
    null,
    'the old comparison against the display URL rejects the real native load',
  );
});

test('old credentials and another retained bundle cannot satisfy the active source', () => {
  const foreign = gatewayResourceSource(uri, { Authorization: 'Bearer previous-credential' });
  for (const loadedUri of [
    foreign.uri,
    source.uri.replace('bundleDigest=head', 'bundleDigest=old'),
  ])
    assert.equal(
      videoSourceLoadDurationMs(source.uri, { videoSource: { uri: loadedUri }, duration: 106 }),
      null,
    );
});

test('unknown sources and nonpositive or nonfinite durations remain unavailable', () => {
  assert.equal(videoSourceLoadDurationMs(source.uri, { videoSource: null, duration: 106 }), null);
  assert.equal(
    videoSourceLoadDurationMs(source.uri, { videoSource: { assetId: 1 }, duration: 106 }),
    null,
  );
  for (const duration of [0, -1, NaN, Infinity])
    assert.equal(
      videoSourceLoadDurationMs(source.uri, { videoSource: { uri: source.uri }, duration }),
      null,
    );
});

test('a matching header-only or string source keeps the same exact identity rule', () => {
  assert.equal(videoSourceLoadDurationMs(uri, { videoSource: uri, duration: 12.5 }), 12500);
  assert.equal(
    videoSourceLoadDurationMs(uri, {
      videoSource: 'https://foreign.test/video.mp4',
      duration: 12.5,
    }),
    null,
  );
});
