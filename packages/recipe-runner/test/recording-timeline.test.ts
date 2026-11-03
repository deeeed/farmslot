import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { createRecordingTimeline, probeVideoTiming } from '../src/recording/timeline.js';

test('trace markers preserve repeated composed nodes and events outside footage', () => {
  const trace = [950, 1200].map((time) => ({
    nodeId: 'journey/open/assert',
    action: 'assert',
    proves: ['AC1'],
    ok: true,
    startedAt: new Date(time).toISOString(),
    endedAt: new Date(time + 10).toISOString(),
    durationMs: 10,
  }));
  const timeline = createRecordingTimeline(
    'run.mp4',
    `sha256:${'a'.repeat(64)}`,
    {
      framesMs: [0, 31, 151, 299],
      durationMs: 310,
      clock: { source: 'measured-test-clock', earliestZeroUnixMs: 1000, latestZeroUnixMs: 1020 },
    },
    trace,
  );
  assert.deepEqual(
    timeline.markers.map((marker) => marker.traceIndex),
    [0, 1],
  );
  assert.deepEqual(timeline.markers[0]!.startRangeMs, [-70, -50]);
  assert.deepEqual(timeline.markers[1]!.startRangeMs, [180, 200]);
  assert.deepEqual(timeline.framesMs, [0, 31, 151, 299]);
  assert.equal(timeline.markers[1]!.nodeId, 'journey/open/assert');
  const otherAttempt = createRecordingTimeline(
    'run.mp4',
    `sha256:${'b'.repeat(64)}`,
    timeline,
    trace,
  );
  assert.notEqual(otherAttempt.videoDigest, timeline.videoDigest);
});

interface ProbeFixture {
  frames: { pts_time?: string | null; best_effort_timestamp_time?: string }[];
  format: { duration: string };
}

async function fixtureProbe(t: TestContext, probe: ProbeFixture) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'timeline-pts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'probe.json');
  const executable = path.join(root, 'ffprobe');
  await writeFile(input, JSON.stringify(probe));
  // Substitute only ffprobe's process output; exercise the real parser and validator.
  await writeFile(executable, '#!/bin/sh\nfor file in "$@"; do :; done\ncat "$file"\n', {
    mode: 0o700,
  });
  return probeVideoTiming(
    input,
    {
      clock: {
        source: 'fixture-clock',
        earliestZeroUnixMs: 1000,
        latestZeroUnixMs: 1000,
      },
    },
    executable,
  );
}

test('real simctl PTS survives probing and timeline construction without dropping equal frames', async (t) => {
  const fixture: { durationSeconds: string; ptsAndBestEffortSeconds: [string, string][] } =
    JSON.parse(
      readFileSync(
        new URL(
          '../../protocol/test/fixtures/simctl-duplicate-frame-timestamps.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
  const frames = fixture.ptsAndBestEffortSeconds.map(([pts_time, best_effort_timestamp_time]) => ({
    pts_time,
    best_effort_timestamp_time,
  }));
  const timing = await fixtureProbe(t, { frames, format: { duration: fixture.durationSeconds } });
  const expected = fixture.ptsAndBestEffortSeconds.map(([pts]) => Number(pts) * 1000);
  assert.deepEqual(timing.framesMs, expected);
  assert.equal(timing.framesMs.length, 327);
  const timeline = createRecordingTimeline('run.mp4', `sha256:${'a'.repeat(64)}`, timing, []);
  assert.deepEqual(timeline.framesMs, expected);
});

test('recorders without explicit PTS can still use nondecreasing best-effort timestamps', async (t) => {
  const timing = await fixtureProbe(t, {
    frames: ['0', '0.1', '0.1', '0.2'].map((best_effort_timestamp_time) => ({
      best_effort_timestamp_time,
    })),
    format: { duration: '0.3' },
  });
  assert.deepEqual(timing.framesMs, [0, 100, 100, 200]);
});

test('backwards PTS is refused even if the best-effort estimate increases', async (t) => {
  await assert.rejects(
    fixtureProbe(t, {
      frames: ['0', '0.2', '0.1'].map((pts_time, index) => ({
        pts_time,
        best_effort_timestamp_time: String(index / 10),
      })),
      format: { duration: '0.3' },
    }),
    /presentation timestamps/,
  );
});

for (const invalid of ['-1', 'NaN', 'Infinity', 'N/A', '', ' ', null]) {
  test(`invalid PTS ${JSON.stringify(invalid)} is refused without replacing it with an estimate`, async (t) => {
    await assert.rejects(
      fixtureProbe(t, {
        frames: [{ pts_time: invalid, best_effort_timestamp_time: '0' }],
        format: { duration: '0.3' },
      }),
      /presentation timestamps/,
    );
  });
}
