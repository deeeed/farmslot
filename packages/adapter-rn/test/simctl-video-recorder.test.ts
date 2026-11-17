import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createIosSimulatorVideoRecorder } from '../src/simctl-video-recorder.js';

// An xcrun stand-in: recordVideo reports an error, then exits cleanly on SIGINT
// without ever writing the output file. It records its pid for the teardown and
// exits on its own after about 10 s, so a stub teardown missed cannot outlive it.
const XCRUN = String.raw`#!/bin/bash
if [[ " $* " != *" recordVideo "* ]]; then printf '{"devices":{}}\n'; exit 0; fi
echo "$$" > "$(dirname "$0")/pid"
trap 'exit 0' INT
echo 'Recording started' >&2
echo 'Error: no display attached' >&2
: > "$(dirname "$0")/ready"
while ((SECONDS < 10)); do sleep 0.02; done
`;

test('a clean stop without an output file names the exit and simctl stderr', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simctl-recorder-test-'));
  fs.writeFileSync(path.join(dir, 'xcrun'), XCRUN, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ''}`;
  t.after(() => {
    process.env.PATH = savedPath;
    // A stub still running keeps this file's process alive, so a failed
    // assertion would hang the suite: stop the fixture's own process first.
    const pidFile = path.join(dir, 'pid');
    const pid = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '';
    const command = pid
      ? spawnSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }).stdout
      : '';
    try {
      if (command.includes(path.join(dir, 'xcrun'))) process.kill(Number(pid), 'SIGKILL');
    } catch (error) {
      // The stub can exit between its ownership probe and the signal.
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Real timers: stop()'s bound must fire if the stub ignores SIGINT.
  const recorder = createIosSimulatorVideoRecorder('sim-1', { stopTimeoutMs: 2_000 });
  const recording = await recorder.start({
    target: { kind: 'simulator', device: 'sim-1' },
    outputPath: path.join(dir, 'recording.mp4'),
    nodeId: 'run',
    record: 'full_run',
  });
  // Bound the wait for the stub to install its trap.
  const readyBy = Date.now() + 5_000;
  while (!fs.existsSync(path.join(dir, 'ready'))) {
    assert.ok(Date.now() < readyBy, 'the xcrun stub never became ready');
    await new Promise(setImmediate);
  }

  await assert.rejects(recording.stop(), (error: Error) => {
    assert.match(error.message, /simctl recordVideo produced no file \(exit 0\)/u);
    assert.match(error.message, /no display attached/u);
    return true;
  });
});
