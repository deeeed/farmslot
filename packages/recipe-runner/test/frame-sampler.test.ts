import assert from 'node:assert/strict';
import test from 'node:test';

import { RecordingFrameSampler } from '../src/recording/frame-sampler.js';

test('an idle final repaint survives rate limiting and stop flushes it', () => {
  const sampler = new RecordingFrameSampler(60);
  const frame = (timestampMs: number, data: string) => ({
    timestampMs,
    receivedAtUnixMs: timestampMs + 2,
    data,
  });
  assert.equal(sampler.accept(frame(1000, 'red')), undefined);
  assert.equal(sampler.accept(frame(1426, 'hover'))?.data, 'red');
  assert.equal(sampler.accept(frame(1491, 'green-before-click'))?.data, 'hover');
  // Just 3 ms later, the settled repaint must replace the hover observation.
  assert.equal(sampler.accept(frame(1494, 'blue-after-click')), undefined);
  const retained = sampler.finish();
  assert.equal(retained?.data, 'blue-after-click');
  assert.equal(retained?.timestampMs, 1494, 'never retime the retained observation');
  assert.equal(sampler.finish(), undefined);
});

test('continuous capture stays bounded by source-clock buckets', () => {
  const sampler = new RecordingFrameSampler(10);
  const retained = [];
  for (let time = 0; time < 1000; time += 3) {
    const frame = sampler.accept({ timestampMs: time, receivedAtUnixMs: time, data: String(time) });
    if (frame) retained.push(frame);
  }
  retained.push(sampler.finish()!);
  assert.equal(retained.length, 10);
  assert.equal(retained.at(-1)?.timestampMs, 999);
  assert.equal(sampler.accept({ timestampMs: 0, receivedAtUnixMs: 0, data: '' }), undefined);
});

test('late and invalid timestamps do not replace a pending repaint or reset the source clock', () => {
  const sampler = new RecordingFrameSampler(10);
  const frame = (timestampMs: number, data: string) => ({
    timestampMs,
    receivedAtUnixMs: 1000,
    data,
  });
  assert.equal(sampler.accept(frame(1000, 'first')), undefined);
  assert.equal(sampler.accept(frame(1100, 'latest'))?.data, 'first');
  for (const timestamp of [1050, NaN, Infinity, -Infinity]) {
    assert.equal(sampler.accept(frame(timestamp, 'discarded')), undefined);
  }
  assert.deepEqual(sampler.finish(), frame(1100, 'latest'));
  assert.equal(sampler.accept(frame(1150, 'settled')), undefined);
  assert.equal(sampler.accept(frame(1200, 'after'))?.data, 'settled');
  assert.deepEqual(sampler.finish(), frame(1200, 'after'));
});
