import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readCaptureHelperTiming } from '../src/recording/capture-helper-timing.js';

test('native timing retains measured frames only for the matching finalized file', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-timing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'run.mp4');
  const bytes = Buffer.from('video fixture bytes');
  await writeFile(video, bytes);
  const data = {
    version: 1,
    recording_id: 'recording-1',
    video_file: 'run.mp4',
    video_digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    frames_ms: [0, 41, 156],
    duration_ms: 180,
    clock: {
      source: 'coremedia-host-clock',
      earliest_zero_unix_ms: 1000,
      latest_zero_unix_ms: 1001,
    },
  };
  await writeFile(video + '.timing.json', JSON.stringify(data));
  const result = await readCaptureHelperTiming(video);
  assert.deepEqual(result.timing?.framesMs, [0, 41, 156]);
  assert.equal(result.timing?.clock.source, 'coremedia-host-clock');
  await writeFile(video, 'changed recording');
  const stale = await readCaptureHelperTiming(video);
  assert.equal(stale.timing, undefined);
  assert.match(stale.timingUnavailableReason!, /digest/);
});
