import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createIosSimulatorVideoRecorder } from '../src/simctl-video-recorder.js';

// An xcrun stand-in: recordVideo reports an error, then exits cleanly on SIGINT
// without ever writing the output file.
const XCRUN = String.raw`#!/bin/bash
trap 'exit 0' INT
echo 'Error: no display attached' >&2
: > "$(dirname "$0")/ready"
while :; do sleep 0.02; done
`;

test('a clean stop without an output file names the exit and simctl stderr', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simctl-recorder-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'xcrun'), XCRUN, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ''}`;
  t.after(() => {
    process.env.PATH = savedPath;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const recorder = createIosSimulatorVideoRecorder('sim-1');
  const starting = recorder.start({
    target: { kind: 'simulator', device: 'sim-1' },
    outputPath: path.join(dir, 'recording.mp4'),
    nodeId: 'run',
    record: 'full_run',
  });
  // start() waits 250ms for an early exit before handing back the recording.
  t.mock.timers.tick(250);
  const recording = await starting;
  // Date is not mocked: bound the wait for the stub to install its trap.
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
