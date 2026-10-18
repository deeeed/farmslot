import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createCaptureHelperVideoRecorder } from '../src/recording/capture-helper.js';

const busyMessage =
  'another capture-helper command is using ScreenCaptureKit on this host; wait for it to finish';

/**
 * A capture-helper that behaves like 0.3.4 while `busy` exists (another slot is recording):
 * doctor fails window enumeration and record refuses, after `refuseAfterMs`, with capture_busy.
 */
async function helperFixture(t: test.TestContext, { refuseAfterMs = 0 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'capture-slot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const busy = path.join(dir, 'busy');
  const attempts = path.join(dir, 'attempts');
  const helper = path.join(dir, 'helper.cjs');
  await writeFile(
    helper,
    `#!/usr/bin/env node
const fs=require('node:fs');
const command=process.argv[2];
if(command==='version'){console.log(JSON.stringify({capabilities:['record_session_timing_v1']}));process.exit(0)}
fs.appendFileSync(${JSON.stringify(attempts)},command+'\\n');
const busy=fs.existsSync(${JSON.stringify(busy)});
if(command==='doctor'){
 const check={id:'window_enumeration',required:true,ok:!busy,code:busy?'capture_busy':'ok',message:busy?${JSON.stringify(busyMessage)}:'ok'};
 console.log(JSON.stringify({ok:!busy,build:{version:'0.3.4'},summary:{requiredFailureCodes:busy?['capture_busy']:[]},checks:[{id:'macos',required:true,ok:true,code:'macos_supported'},check]}));
 process.exit(busy?1:0);
}
if(busy){setTimeout(()=>{process.stderr.write(JSON.stringify({code:'capture_busy',message:${JSON.stringify(busyMessage)},type:'error'})+'\\n');process.exit(1)},${refuseAfterMs});return}
const out=process.argv[process.argv.indexOf('--output')+1];
process.stderr.write(JSON.stringify({type:'record_ready',recording_id:'slot-test'})+'\\n');
process.on('SIGINT',()=>{fs.writeFileSync(out,'video fixture');process.exit(0)});
setInterval(()=>{},1000);
`,
    { mode: 0o755 },
  );
  await writeFile(busy, '');
  const count = async (command: string) =>
    existsSync(attempts)
      ? (await readFile(attempts, 'utf8')).split('\n').filter((line) => line === command).length
      : 0;
  return {
    dir,
    helper,
    attempts: count,
    free: () => rm(busy, { force: true }),
    /** The other slot finishes once `command` has been refused at least once. */
    async freeAfterRefusal(command: string) {
      while ((await count(command)) === 0) await delay(20);
      await rm(busy, { force: true });
    },
  };
}

const request = (dir: string, signal?: AbortSignal) => ({
  target: { kind: 'window-id' as const, windowId: '1' },
  outputPath: path.join(dir, 'out.mp4'),
  nodeId: 'recipe-run',
  record: 'full_run' as const,
  ...(signal ? { signal } : {}),
});

test('a recording waits for another slot to release the host capture slot', async (t) => {
  if (process.platform === 'win32') return t.skip('shebang helper');
  const fixture = await helperFixture(t);
  const recorder = createCaptureHelperVideoRecorder({
    captureHelperPath: fixture.helper,
    captureSlotWaitMs: 10_000,
    captureSlotPollMs: 50,
  });
  const freed = fixture.freeAfterRefusal('record');
  const active = await recorder.start(request(fixture.dir));
  await freed;
  const result = await active.stop();
  assert.ok((await fixture.attempts('record')) > 1, 'the busy refusal was retried');
  assert.equal(result.segments[0]?.path, 'out.mp4');
});

test('a refusal after the early-exit window still waits instead of failing the first frame', async (t) => {
  if (process.platform === 'win32') return t.skip('shebang helper');
  const fixture = await helperFixture(t, { refuseAfterMs: 600 });
  const recorder = createCaptureHelperVideoRecorder({
    captureHelperPath: fixture.helper,
    captureSlotWaitMs: 10_000,
    captureSlotPollMs: 50,
  });
  const freed = fixture.freeAfterRefusal('record');
  const active = await recorder.start(request(fixture.dir));
  await freed;
  await active.stop();
  assert.ok((await fixture.attempts('record')) > 1);
});

test('run-start doctor waits for the slot instead of failing on capture_busy', async (t) => {
  if (process.platform !== 'darwin') return t.skip('doctor is macOS-only');
  const fixture = await helperFixture(t);
  const recorder = createCaptureHelperVideoRecorder({
    captureHelperPath: fixture.helper,
    captureSlotWaitMs: 10_000,
    captureSlotPollMs: 50,
  });
  const freed = fixture.freeAfterRefusal('doctor');
  const doctor = await recorder.doctor!();
  await freed;
  assert.equal(doctor.ok, true, doctor.message);
  assert.ok((await fixture.attempts('doctor')) > 1);
});

test('a slot held past the bound fails with the capture-slot reason', async (t) => {
  if (process.platform === 'win32') return t.skip('shebang helper');
  const fixture = await helperFixture(t);
  const recorder = createCaptureHelperVideoRecorder({
    captureHelperPath: fixture.helper,
    captureSlotWaitMs: 1_000,
    captureSlotPollMs: 50,
  });
  await assert.rejects(
    recorder.start(request(fixture.dir)),
    /Waited 1 s for this host's capture slot; another capture-helper command, likely a recording in another slot, still holds it \(capture_busy\)/,
  );
  if (process.platform !== 'darwin') return;
  const doctor = await recorder.doctor!();
  assert.equal(doctor.ok, false);
  assert.equal(doctor.code, 'capture_busy');
  assert.match(doctor.message, /Waited 1 s for this host's capture slot/);
  assert.doesNotMatch(doctor.suggestedFix ?? '', /open-permissions/);
});

test('a cancelled run stops waiting for the slot and starts nothing later', async (t) => {
  if (process.platform === 'win32') return t.skip('shebang helper');
  const fixture = await helperFixture(t);
  const recorder = createCaptureHelperVideoRecorder({
    captureHelperPath: fixture.helper,
    captureSlotWaitMs: 60_000,
    captureSlotPollMs: 50,
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const startedAt = Date.now();
  await assert.rejects(recorder.start(request(fixture.dir, controller.signal)), {
    name: 'AbortError',
  });
  assert.ok(Date.now() - startedAt < 5_000);
  const attempts = await fixture.attempts('record');
  await fixture.free();
  await delay(300);
  assert.equal(await fixture.attempts('record'), attempts, 'no attempt after the cancel');
});
