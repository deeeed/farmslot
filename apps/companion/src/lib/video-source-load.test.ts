import assert from 'node:assert/strict';
import test from 'node:test';

import type { VideoPlayerStatus } from 'expo-video';

import { restoreRecordingTimeMs } from '@farmslot/adapter-sdk/evidence';
import { viewScopedIntegerField } from '@farmslot/protocol';

import {
  observeLoadedVideoReady,
  sameRecordingSeek,
  videoSourceLoadDurationMs,
} from './video-source-load';

const uri = 'https://gateway.test/api/run-artifact?runId=run-a&path=video.mp4&bundleDigest=head';
// Native sourceLoad observation, with the private fixture credential replaced.
const source = {
  uri: 'https://gateway.test/api/run-artifact?runId=run-a&path=video.mp4&bundleDigest=head&token=service-test-credential',
};

test('authenticated source metadata uses the URI actually delivered to the native player', () => {
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
  const foreign = {
    uri: 'https://gateway.test/api/run-artifact?runId=run-a&path=video.mp4&bundleDigest=head&token=previous-credential',
  };
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

test('the matching timed link restores when the loaded player becomes ready at the same duration', () => {
  const recording = JSON.stringify(['artifacts/videos/recipe-run.mp4', 'retained-revision']);
  const at = viewScopedIntegerField('mediaTimelineAt', 'mediaTimelineAnchor', recording, -1);
  const params = new URLSearchParams({ mediaTimelineAt: '11388', mediaTimelineAnchor: recording });
  const requested = at.read(params);
  const duration = 41.97100067138672;
  const loadedDurationMs = videoSourceLoadDurationMs(source.uri, { videoSource: source, duration });
  assert.ok(loadedDurationMs !== null);
  const listeners = new Set<() => void>();
  let status: VideoPlayerStatus = 'loading';
  const player = {
    get status() {
      return status;
    },
    duration,
    addListener(event: 'statusChange', listener: () => void) {
      assert.equal(event, 'statusChange');
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  const seeks: Array<number | null> = [];
  const restore = (durationMs: number) => seeks.push(restoreRecordingTimeMs(requested, durationMs));
  const foreign = observeLoadedVideoReady(
    player,
    source.uri,
    { player, uri, durationMs: loadedDurationMs },
    restore,
  );
  const remove = observeLoadedVideoReady(
    player,
    source.uri,
    { player, uri: source.uri, durationMs: loadedDurationMs },
    restore,
  );
  assert.deepEqual(seeks, []);
  assert.equal(foreign, undefined);
  status = 'readyToPlay';
  assert.equal(player.duration * 1000, loadedDurationMs);
  const [queued] = listeners;
  assert.ok(queued);
  queued();
  assert.deepEqual(seeks, [11388]);

  remove?.();
  assert.equal(listeners.size, 0);
  queued();
  assert.deepEqual(seeks, [11388]);
  observeLoadedVideoReady(
    player,
    source.uri,
    { player, uri: source.uri, durationMs: loadedDurationMs },
    restore,
  )?.();
  assert.deepEqual(seeks, [11388, 11388]);
});

test('the saved seek must reapply and reconfirm after gateway playback becomes a cached source', () => {
  const gateway = {
    player: {},
    sourceUri: source.uri,
    recording: JSON.stringify(['artifacts/videos/recipe-run.mp4', 'retained-revision']),
    atMs: 11388,
  };
  const cached = { ...gateway, sourceUri: 'file:///recording-cache/retained.mp4' };
  const replacement = { ...cached, player: {} };
  let applied = gateway;
  let confirmed = gateway;
  for (const active of [cached, replacement]) {
    assert.equal(sameRecordingSeek(confirmed, active), false);
    if (!sameRecordingSeek(applied, active)) applied = active;
    assert.equal(applied, active);
    confirmed = active;
    assert.equal(sameRecordingSeek(confirmed, { ...active }), true);
  }
});

test('a ready event with the same URI cannot use duration from a retired player', () => {
  const ready = (): { status: VideoPlayerStatus; addListener(): { remove(): void } } => ({
    status: 'readyToPlay',
    addListener() {
      return { remove() {} };
    },
  });
  const retired = ready();
  const active = ready();
  const loaded = { player: retired, uri: source.uri, durationMs: 41971 };
  const seeks: number[] = [];
  const recordSeek = (durationMs: number) => seeks.push(durationMs);
  assert.equal(observeLoadedVideoReady(active, source.uri, loaded, recordSeek), undefined);
  assert.deepEqual(seeks, []);
  observeLoadedVideoReady(active, source.uri, { ...loaded, player: active }, recordSeek)?.();
  assert.deepEqual(seeks, [41971]);
});
