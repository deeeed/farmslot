import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { EVIDENCE_PADDING_MS } from '@farmslot/protocol';
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
  pull)
    [ ! -f "$dir/fail-pull" ] || [[ "$2" != *-1.mp4 ]] || { echo 'transfer failed' >&2; exit 1; }
    cp "$dir/device/$(basename "$2")" "$3" ;;
  shell)
    shift
    case "$1" in
      pidof)
        pids="$(ls "$dir/running")"
        [ -n "$pids" ] || exit 1
        for pid in $pids; do : > "$dir/seen-$pid"; done
        echo "$pids" ;;
      cat)
        pid="$(printf '%s' "$2" | cut -d/ -f3)"
        [ -f "$dir/running/$pid" ] || exit 1
        printf '%s\0' screenrecord --time-limit 180 "$(cat "$dir/running/$pid")" ;;
      kill) : > "$dir/stop-$3" ;;
      stat)
        file="$dir/device/$(basename "$4")"
        [ -f "$file" ] || exit 1
        wc -c < "$file" | tr -d ' ' ;;
      rm) shift 2; for file in "$@"; do rm -f "$dir/device/$(basename "$file")"; done ;;
      screenrecord)
        [ "$2" = --help ] && exit 0
        echo "$$" >> "$dir/owned-pids"
        [ ! -f "$dir/slow-start" ] || sleep 0.3
        file="$dir/device/$(basename "$4")"
        : > "$file"; printf '%s' "$4" > "$dir/running/$$"
        # The muxer writes its header once the encoder has a first frame.
        [ ! -f "$dir/slow-header" ] || sleep 0.3
        printf 'header' > "$file"
        finish() {
          if [ -f "$dir/empty" ]; then : > "$file"; else printf 'original %s' "$file" > "$file"; fi
          rm -f "$dir/running/$$"
          exit "$1"
        }
        trap 'finish 143' TERM
        while :; do
          [ ! -f "$dir/crash" ] || finish 3
          [ ! -f "$dir/end-$$" ] || [ ! -f "$dir/seen-$$" ] || finish 0
          if [ -f "$dir/stop-$$" ]; then
            [ ! -f "$dir/fail-on-stop" ] || finish 1
            finish 0
          fi
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
        ...(recording.ready ? { ready: () => recording.ready!() } : {}),
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

test('a segment starts once its file has a first frame and bounds its zero by it', async (t) => {
  const d = device(t);
  d.set('slow-header');
  const requestedAt = Date.now();
  const recording = await d.recorder.start(d.request);
  const startedAfterMs = Date.now() - requestedAt;
  const [remote] = fs.readdirSync(path.join(d.dir, 'device'));
  assert.ok(fs.statSync(path.join(d.dir, 'device', remote!)).size > 0, 'start waits for bytes');
  assert.ok(startedAfterMs >= 250, `start returned after ${startedAfterMs} ms`);
  const clock = (await recording.stop()).segments[0]?.timing?.clock;
  assert.equal(clock?.source, 'adb-screenrecord-first-write');
  assert.ok(clock!.latestZeroUnixMs - clock!.earliestZeroUnixMs >= 250);
  assert.ok(clock!.latestZeroUnixMs <= requestedAt + startedAfterMs);
});

test('ready waits through a 180-second roll until the restarted segment has a frame', async (t) => {
  const d = device(t);
  const recording = await d.recorder.start(d.request);
  await recording.ready!();
  d.set('slow-header');
  d.set(`end-${d.running()[0]}`);
  const starts = () =>
    d.calls().filter((call) => call.startsWith('shell screenrecord --time')).length;
  await waitFor(() => assert.equal(starts(), 2));
  await recording.ready!();
  const readyAt = Date.now();
  const restarted = fs
    .readdirSync(path.join(d.dir, 'device'))
    .find((name) => name.endsWith('-1.mp4'));
  assert.ok(restarted, 'the roll started a second segment');
  assert.ok(
    fs.statSync(path.join(d.dir, 'device', restarted)).size > 0,
    'ready waited for its frame',
  );
  const { segments } = await recording.stop();
  assert.equal(segments.length, 2);
  // The next proof node gets the first bind's lead-in after the restarted segment's zero.
  const zero = segments[1]?.timing?.clock?.latestZeroUnixMs;
  assert.ok(zero !== undefined, 'the restarted segment has a measured clock');
  assert.ok(readyAt - zero >= EVIDENCE_PADDING_MS - 10, `ready ${readyAt - zero} ms after zero`);
});

test('ready restarts a segment past 150 seconds, so the roll falls between proof nodes', async (t) => {
  const d = device(t);
  const realNow = Date.now.bind(Date);
  let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  const starts = () =>
    d.calls().filter((call) => call.startsWith('shell screenrecord --time')).length;
  const recording = await d.recorder.start(d.request);
  await recording.ready!();
  assert.equal(starts(), 1, 'a young segment keeps recording');
  offset = 151_000;
  const rollRequestedAt = realNow();
  await recording.ready!();
  assert.equal(starts(), 2, 'an old segment restarts before its limit');
  // One padding of the old segment's tail before the restart, then the new segment's lead-in.
  assert.ok(
    realNow() - rollRequestedAt >= 2 * EVIDENCE_PADDING_MS - 20,
    'a padding before the restart and a lead-in after it',
  );
  const restarted = fs
    .readdirSync(path.join(d.dir, 'device'))
    .find((name) => name.endsWith('-1.mp4'));
  assert.ok(restarted && fs.statSync(path.join(d.dir, 'device', restarted)).size > 0);
  const result = await recording.stop();
  assert.equal(result.segments.length, 2);
  assert.equal(result.interruption, undefined);
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
  await assert.rejects(recording.stop(), /RECORDER_INTERRUPTED/);
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
  assert.equal(fs.readdirSync(path.join(d.dir, 'device')).length, 1);
  assert.equal(process.listenerCount('SIGTERM'), guards);
  const partial = await recording.stop();
  assert.equal(partial.segments.length, 1);
  assert.match(partial.interruption?.cause ?? '', /SIGTERM/);
  assert.ok(
    fs.existsSync(path.join(path.dirname(d.request.outputPath), partial.segments[0]!.path)),
  );
  assert.deepEqual(fs.readdirSync(path.join(d.dir, 'device')), []);
});

for (const failure of ['fail-on-stop', 'empty', 'fail-pull']) {
  test(`retains the completed prefix with interruption after ${failure}`, async (t) => {
    const d = device(t);
    const recording = await d.recorder.start(d.request);
    const first = d.running()[0];
    d.set(`end-${first}`);
    await waitFor(() => assert.ok(d.running().some((pid) => pid !== first)));
    d.set(failure);
    const result = await recording.stop();
    assert.equal(result.segments.length, 1);
    assert.ok(result.interruption?.cause);
    assert.ok(fs.statSync(d.request.outputPath).size > 0);
    assert.deepEqual(d.running(), []);
    assert.deepEqual(fs.readdirSync(path.join(d.dir, 'device')), []);
  });
}

test('startup cancellation leaves a foreign recorder and its file untouched', async (t) => {
  const d = device(t);
  const keepTestAlive = () => {};
  process.on('SIGTERM', keepTestAlive);
  t.after(() => process.removeListener('SIGTERM', keepTestAlive));
  d.set('slow-start');
  const starting = d.recorder.start(d.request);
  const refused = assert.rejects(starting, /exited before capture started/);
  fs.writeFileSync(path.join(d.dir, 'running', '999999'), '/sdcard/Download/manual.mp4');
  fs.writeFileSync(path.join(d.dir, 'device', 'manual.mp4'), 'foreign video');
  process.emit('SIGTERM');
  await refused;
  assert.deepEqual(d.running(), ['999999']);
  assert.equal(fs.readFileSync(path.join(d.dir, 'device', 'manual.mp4'), 'utf8'), 'foreign video');
  assert.ok(!d.calls().includes('shell kill -2 999999'));
});
