import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSharedViewLink } from '@farmslot/protocol/surfaces/view-links';

import { mediaShareView, observeRecordingAnchor, type RecordingAnchor } from './media-share-view';

test('a changed video selection refuses the opening artifact until a new observed item opens', () => {
  const opened = { runId: 'run-A', path: 'recording-A.mp4', traceIndex: 3 };
  const initial = mediaShareView(opened, false);
  assert(initial);
  assert.equal(
    resolveSharedViewLink({ companion: initial }, 'https://cc.example/').status,
    'available',
  );
  const changed = mediaShareView(opened, true);
  assert(changed);
  const refused = resolveSharedViewLink({ companion: changed }, 'https://cc.example/');
  assert.equal(refused.status, 'unavailable');
  if (refused.status === 'unavailable')
    assert.match(refused.message, /selected recording or occurrence/);
  const reopened = mediaShareView(
    { runId: 'run-A', path: 'recording-B.mp4', traceIndex: 7 },
    false,
  );
  assert(reopened);
  const result = resolveSharedViewLink({ companion: reopened }, 'https://cc.example/');
  assert(result.status === 'available');
  assert.match(result.route, /artifact=recording-B.mp4/);
  assert.match(result.route, /artifactTrace=7/);
});

test('paused playback invalidates the saved timeline anchor only after the seek lands', () => {
  const requested = { requestedMs: 11_000, previousMs: 41_000 };
  assert.equal(observeRecordingAnchor(requested, false, 41_000), 'pending');
  assert.equal(observeRecordingAnchor(requested, false, 24_000), 'moved');
  assert.equal(observeRecordingAnchor(requested, false, 11_004), 'confirmed');
  const landed = { ...requested, observedMs: 11_004 };
  assert.equal(observeRecordingAnchor(landed, false, 11_004), 'confirmed');
  assert.equal(observeRecordingAnchor(landed, false, 12_000), 'moved');
  assert.equal(observeRecordingAnchor(landed, true, 11_004), 'moved');
});

test('a queued sample at the old paused position cannot confirm a 50 ms seek', () => {
  const anchor: RecordingAnchor = { requestedMs: 11_050, previousMs: 11_000 };
  const changes = [11_000, 11_050, 11_050].map((positionMs) => {
    const observed = observeRecordingAnchor(anchor, false, positionMs);
    if (observed === 'confirmed' && anchor.observedMs === undefined) anchor.observedMs = positionMs;
    return observed;
  });
  assert.deepEqual(changes, ['pending', 'confirmed', 'confirmed']);
});

test('a seek to the same link millisecond can confirm without a position change', () => {
  const anchor = { requestedMs: 11_000, previousMs: 11_000.2 };
  assert.equal(observeRecordingAnchor(anchor, false, 11_000.2), 'confirmed');
});

test('a seek one link millisecond away can confirm on the new millisecond', () => {
  const anchor = { requestedMs: 11_001, previousMs: 11_000 };
  assert.equal(observeRecordingAnchor(anchor, false, 11_000), 'pending');
  assert.equal(observeRecordingAnchor(anchor, false, 11_001), 'confirmed');
});
