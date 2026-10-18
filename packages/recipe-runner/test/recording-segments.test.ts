import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startSegmentedRecording } from '../src/core/recording-segments.js';
import type { VideoRecorder } from '../src/core/types.js';

test('native rotation retains original segments and exposes a restart gap', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-segments-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  let starts = 0;
  let stops = 0;
  let rotated!: () => void;
  const next = new Promise<void>((resolve) => {
    rotated = resolve;
  });
  const watchdog = setTimeout(() => assert.fail('Native segment did not rotate.'), 1_000);
  t.after(() => clearTimeout(watchdog));
  const recorder: VideoRecorder = {
    name: 'native-fixture',
    async start(request) {
      starts++;
      await writeFile(request.outputPath, 'source');
      if (starts === 2) rotated();
      return {
        snapshot: async () => ({}),
        stop: async () => {
          stops++;
          return { segments: [{ path: path.basename(request.outputPath) }] };
        },
      };
    },
  };
  const active = await startSegmentedRecording(recorder, {
    outputPath: path.join(root, 'source.mp4'),
    target: { kind: 'pid', pid: 1 },
    nodeId: 'run',
    record: 'full_run',
  });
  now = 10 * 60 * 1_000;
  await next;
  assert.equal((await active.snapshot!('frame.png')).segmentIndex, 1);
  const result = await active.stop();
  assert.equal(starts, 2);
  assert.equal(stops, 2);
  assert.deepEqual(
    result.segments.map((segment) => [segment.path, segment.gapBefore ?? false]),
    [
      ['source.mp4', false],
      ['source-segment-1.mp4', true],
    ],
  );
  assert.equal(await active.stop(), result);
});

test('a segmented recording forwards ready only when the recorder has it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-ready-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let readyCalls = 0;
  const recorder = (withReady: boolean): VideoRecorder => ({
    name: 'ready-fixture',
    async start(request) {
      await writeFile(request.outputPath, 'source');
      return {
        ...(withReady ? { ready: async () => void readyCalls++ } : {}),
        stop: async () => ({ segments: [{ path: path.basename(request.outputPath) }] }),
      };
    },
  });
  const request = (name: string) => ({
    outputPath: path.join(root, name),
    target: { kind: 'pid' as const, pid: 1 },
    nodeId: 'run',
    record: 'full_run' as const,
  });
  const ready = await startSegmentedRecording(recorder(true), request('ready.mp4'));
  const plain = await startSegmentedRecording(recorder(false), request('plain.mp4'));
  await ready.ready!();
  assert.equal(readyCalls, 1);
  assert.equal(plain.ready, undefined);
  await ready.stop();
  await plain.stop();
});
