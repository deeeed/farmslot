import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { boundRecording } from '../src/core/recording-limits.js';

for (const kind of ['duration', 'bytes'] as const) {
  test(`capture ${kind} limit finalizes once and retains partial source segments`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'record-limit-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const output = path.join(root, 'source.mp4');
    let stops = 0;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const keepAlive = setTimeout(
      () => assert.fail('Capture limit did not stop its backend.'),
      1_000,
    );
    t.after(() => clearTimeout(keepAlive));
    const active = boundRecording(
      {
        snapshot: async () => ({}),
        stop: async () => {
          stops++;
          finish();
          return { segments: [{ path: 'source.mp4' }] };
        },
      },
      output,
      kind === 'duration' ? { maxDurationMs: 20 } : { maxBytes: 2 },
    );
    if (kind === 'bytes') await writeFile(output, 'source bytes');
    await done;
    const first = await active.stop();
    const second = await active.stop();
    assert.equal(stops, 1);
    assert.equal(first, second);
    assert.deepEqual(
      first.segments.map((segment) => segment.path),
      ['source.mp4'],
    );
    assert.match(first.interruption?.cause ?? '', /limit reached/);
    await assert.rejects(active.snapshot!('frame.png'), /limit reached/);
  });
}

test('normal completion clears limit observation and never stops twice', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'record-limit-normal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let stops = 0;
  const active = boundRecording(
    {
      stop: async () => {
        stops++;
        return { segments: [] };
      },
    },
    path.join(root, 'source.mp4'),
    {},
  );
  assert.equal((await active.stop()).interruption, undefined);
  await active.stop();
  assert.equal(stops, 1);
});
