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
