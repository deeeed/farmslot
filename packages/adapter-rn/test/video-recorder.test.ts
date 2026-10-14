import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import type { ActiveVideoRecording, VideoRecorderStartRequest } from '@farmslot/recipe-runner';

import { createAndroidVideoRecorder } from '../src/video-recorder.js';

import { waitFor } from './_helpers.js';

// A device stand-in: only a listed recorder can finish its time-limited file.
// Each process and remote file belongs to this temporary fixture.
const ADB = String.raw`#!/bin/bash
dir="$(cd "$(dirname "$0")" && pwd)"
shift 2
echo "$*" >> "$dir/calls"
case "$1" in
  get-state) echo device ;;
  pull) cp "$dir/device/$(basename "$2")" "$3" ;;
  shell)
    shift
    case "$1" in
      pidof)
        pids="$(ls "$dir/running")"
        [ -n "$pids" ] || exit 1
        for pid in $pids; do : > "$dir/seen-$pid"; done
        echo "$pids" ;;
      kill) : > "$dir/stop-$3" ;;
      rm) shift 2; for file in "$@"; do rm -f "$dir/device/$(basename "$file")"; done ;;
      screenrecord)
        [ "$2" = --help ] && exit 0
        echo "$$" >> "$dir/owned-pids"
        [ ! -f "$dir/slow-start" ] || sleep 0.3
        file="$dir/device/$(basename "$4")"
        : > "$file"; : > "$dir/running/$$"
        finish() {
          [ -f "$dir/empty" ] || printf 'original %s' "$file" > "$file"
          rm -f "$dir/running/$$"
          exit "$1"
        }
        trap 'finish 143' TERM
        while :; do
          [ ! -f "$dir/crash" ] || finish 3
          [ ! -f "$dir/end-$$" ] || [ ! -f "$dir/seen-$$" ] || finish 0
          [ ! -f "$dir/stop-$$" ] || finish 0
          sleep 0.02
        done ;;
      *) exit 2 ;;
    esac ;;
  *) exit 2 ;;
esac
`;

function device(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-recorder-test-'));
  fs.mkdirSync(path.join(dir, 'running'));
  fs.mkdirSync(path.join(dir, 'device'));
  fs.writeFileSync(path.join(dir, 'adb'), ADB, { mode: 0o755 });
  const ffprobe = path.join(dir, 'ffprobe');
  fs.writeFileSync(
    ffprobe,
    `#!/bin/bash\nprintf '%s' '{"frames":[{"best_effort_timestamp_time":"0"},{"best_effort_timestamp_time":"0.001"}],"format":{"duration":"0.002"}}'\n`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  const oldProbe = process.env.FFPROBE_PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
  process.env.FFPROBE_PATH = ffprobe;
  let active: ActiveVideoRecording | undefined;
  let stopped = false;
  t.after(async () => {
    let cleanupError: unknown;
    try {
      if (active && !stopped) await active.stop();
    } catch (error) {
      cleanupError = error;
    }
    try {
      // Emergency cleanup stays bound to the fixture's own process argv.
      const owned = path.join(dir, 'owned-pids');
      for (const pid of fs.existsSync(owned)
        ? fs.readFileSync(owned, 'utf8').trim().split('\n')
        : []) {
        const command = spawnSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' });
        if (!command.stdout.includes(path.join(dir, 'adb'))) continue;
        try {
          process.kill(Number(pid), 'SIGTERM');
        } catch (error) {
          // A fixture can finish between its ownership probe and the signal.
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
            cleanupError ??= error;
        }
      }
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldProbe === undefined) delete process.env.FFPROBE_PATH;
      else process.env.FFPROBE_PATH = oldProbe;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (cleanupError !== undefined) throw cleanupError;
  });
  const request: VideoRecorderStartRequest = {
    outputPath: path.join(dir, 'output', 'recipe-run.mp4'),
    target: { kind: 'android-device', serial: 'unit-device' },
    nodeId: 'recipe-run',
    record: 'full_run',
  };
  const base = createAndroidVideoRecorder('unit-device');
  const recorder = {
    ...base,
    async start(request: VideoRecorderStartRequest) {
      const recording = await base.start(request);
      active = {
        stop() {
          stopped = true;
          return recording.stop();
        },
      };
      return active;
    },
  };
  return {
    dir,
    request,
    recorder,
    set: (name: string) => fs.writeFileSync(path.join(dir, name), ''),
    running: () => fs.readdirSync(path.join(dir, 'running')),
    calls: () => fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n'),
  };
}

test('short capture retains its filename, measured timing and removes device files', async (t) => {
  const d = device(t);
  const guards = process.listenerCount('SIGTERM');
  const recording = await d.recorder.start(d.request);
  const result = await recording.stop();
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0]?.path, 'recipe-run.mp4');
  assert.deepEqual(result.segments[0]?.timing?.framesMs, [0, 1]);
  assert.equal(result.interruption, undefined);
  assert.deepEqual(d.running(), []);
  assert.deepEqual(fs.readdirSync(path.join(d.dir, 'device')), []);
  assert.equal(process.listenerCount('SIGTERM'), guards);
  await assert.rejects(recording.stop(), /already stopped/);
});

test('180-second completion rotates into ordered original segments with explicit restart gaps', async (t) => {
  const d = device(t);
  const recording = await d.recorder.start(d.request);
  const first = d.running()[0];
  assert.ok(first);
  d.set(`end-${first}`);
  await waitFor(() => assert.ok(d.running().some((pid) => pid !== first)));
  const result = await recording.stop();
  assert.deepEqual(
    result.segments.map((segment) => segment.path),
    ['recipe-run.mp4', 'recipe-run.segment-1.mp4'],
  );
  assert.equal(result.segments[1]?.gapBefore, true);
  assert.ok(result.segments.every((segment) => segment.timing));
  assert.ok(
    result.segments[1]!.timing!.clock.earliestZeroUnixMs >
      result.segments[0]!.timing!.clock.earliestZeroUnixMs,
  );
  assert.ok(
    d
      .calls()
      .filter((call) => call.startsWith('shell screenrecord --time-limit'))
      .every((call) => call.startsWith('shell screenrecord --time-limit 180 ')),
  );
  assert.deepEqual(d.running(), []);
  assert.deepEqual(fs.readdirSync(path.join(d.dir, 'device')), []);
});

test('stop during rotation waits for the owned starting segment and prevents another restart', async (t) => {
  const d = device(t);
  const recording = await d.recorder.start(d.request);
  d.set('slow-start');
  d.set(`end-${d.running()[0]}`);
  await waitFor(() =>
    assert.equal(
      d.calls().filter((call) => call.startsWith('shell screenrecord --time-limit')).length,
      2,
    ),
  );
  const result = await recording.stop();
  assert.equal(result.segments.length, 2);
  assert.equal(
    d.calls().filter((call) => call.startsWith('shell screenrecord --time-limit')).length,
    2,
  );
  assert.deepEqual(d.running(), []);
  assert.deepEqual(fs.readdirSync(path.join(d.dir, 'device')), []);
});

test('mid-run failure retains the completed prefix and reports interruption', async (t) => {
  const d = device(t);
  const recording = await d.recorder.start(d.request);
  const first = d.running()[0];
  d.set(`end-${first}`);
  await waitFor(() => assert.ok(d.running().some((pid) => pid !== first)));
  d.set('crash');
  await waitFor(() => assert.deepEqual(d.running(), []));
  const result = await recording.stop();
  assert.equal(result.segments.length, 1);
  assert.match(result.interruption?.cause ?? '', /exit 3/);
  assert.equal(result.interruption?.frames, 2);
  assert.deepEqual(fs.readdirSync(path.join(d.dir, 'device')), []);
});

test('empty capture fails and leaves no published output or recording guard', async (t) => {
  const d = device(t);
  d.set('empty');
  const guards = process.listenerCount('SIGTERM');
  const recording = await d.recorder.start(d.request);
  await assert.rejects(recording.stop(), /RECORDING_FAILED/);
  assert.deepEqual(fs.readdirSync(path.dirname(d.request.outputPath)), []);
  assert.deepEqual(d.running(), []);
  assert.deepEqual(fs.readdirSync(path.join(d.dir, 'device')), []);
  assert.equal(process.listenerCount('SIGTERM'), guards);
});

test('foreign recording and wrong device are refused before capture starts', async (t) => {
  const d = device(t);
  d.set('running/foreign');
  await assert.rejects(d.recorder.start(d.request), /already running/);
  assert.ok(!d.calls().some((call) => call.startsWith('shell screenrecord --time-limit')));
  await assert.rejects(
    d.recorder.start({
      ...d.request,
      target: { kind: 'android-device', serial: 'another-device' },
    }),
    /does not match/,
  );
});

test('host signal removes owned recorder files and unregisters its guards', async (t) => {
  const d = device(t);
  // Keep the test process alive while exercising the real registered handler.
  const keepTestAlive = () => {};
  process.on('SIGTERM', keepTestAlive);
  t.after(() => process.removeListener('SIGTERM', keepTestAlive));
  const guards = process.listenerCount('SIGTERM');
  const recording = await d.recorder.start(d.request);
  process.emit('SIGTERM');
  assert.deepEqual(d.running(), []);
  assert.deepEqual(fs.readdirSync(path.join(d.dir, 'device')), []);
  assert.equal(process.listenerCount('SIGTERM'), guards);
  await assert.rejects(recording.stop(), /RECORDER_INTERRUPTED|Could not pull Android recording/);
});
