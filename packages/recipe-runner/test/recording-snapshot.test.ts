import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createAndroidMirrorVideoRecorder } from '../src/recording/android-mirror.js';
import { createCaptureHelperVideoRecorder } from '../src/recording/capture-helper.js';

test('timing-capable recorder rejects snapshots that omit recording timing', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'record-invalid-timing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const helper = path.join(dir, 'helper.cjs');
  await writeFile(
    helper,
    `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv[2]==='version'){console.log(JSON.stringify({capabilities:['record_session_snapshot','record_session_timing_v1']}));process.exit(0)}
const out=process.argv[process.argv.indexOf('--output')+1];
process.stderr.write(JSON.stringify({type:'record_ready',recording_id:'test'})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const output=line.slice(9);fs.writeFileSync(output,'PNG fixture');process.stderr.write(JSON.stringify({type:'snapshot',output})+'\\n');
});
process.on('SIGINT',()=>{fs.writeFileSync(out,'video fixture');process.exit(0)});
`,
    { mode: 0o755 },
  );
  const active = await createCaptureHelperVideoRecorder({ captureHelperPath: helper }).start({
    target: { kind: 'window-id', windowId: '1' },
    outputPath: path.join(dir, 'out.mp4'),
    nodeId: 'run',
    record: 'full_run',
  });
  try {
    await assert.rejects(active.snapshot!(path.join(dir, 'shot.png')), /omitted valid timing/);
  } finally {
    await active.stop();
  }
});

test('loss of the owned mirror after start invalidates recording completion', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Native capture provider is macOS-only');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'record-mirror-exit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const identity = path.join(dir, 'identity.json'),
    mirror = path.join(dir, 'scrcpy.cjs'),
    helper = path.join(dir, 'helper.cjs');
  await writeFile(
    mirror,
    `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('test');process.exit(0)}
require('node:fs').writeFileSync(${JSON.stringify(identity)},JSON.stringify({pid:process.pid,title:process.argv[process.argv.indexOf('--window-title')+1],id:1}));
setInterval(()=>{},1000);
`,
    { mode: 0o755 },
  );
  await writeFile(
    helper,
    `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv[2]==='doctor'){console.log(JSON.stringify({ok:true}));process.exit(0)}
if(process.argv[2]==='version'){console.log(JSON.stringify({capabilities:[]}));process.exit(0)}
if(process.argv[2]==='list'){console.log(JSON.stringify({windows:fs.existsSync(${JSON.stringify(identity)})?[JSON.parse(fs.readFileSync(${JSON.stringify(identity)},'utf8'))]:[]}));process.exit(0)}
const out=process.argv[process.argv.indexOf('--output')+1];
process.on('SIGINT',()=>{fs.writeFileSync(out,'video fixture');process.exit(0)});setInterval(()=>{},1000);
`,
    { mode: 0o755 },
  );
  const recorder = createAndroidMirrorVideoRecorder({
    serial: 'fixture-device',
    scrcpyPath: mirror,
    captureHelperPath: helper,
    fallback: {
      name: 'unexpected',
      async start() {
        throw Error('Unexpected fallback');
      },
    },
  });
  const active = await recorder.start({
    target: { kind: 'android-device', serial: 'fixture-device' },
    outputPath: path.join(dir, 'out.mp4'),
    nodeId: 'run',
    record: 'full_run',
  });
  const processIdentity = JSON.parse(await readFile(identity, 'utf8'));
  process.kill(processIdentity.pid, 'SIGTERM');
  await delay(50);
  await assert.rejects(active.stop(), /mirror exited during recording/);
  assert.throws(() => process.kill(processIdentity.pid, 0), /ESRCH/);
});

test('capture session snapshots correlate by path and reject duplicate pending output', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'record-session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const helper = path.join(dir, 'helper.cjs');
  await writeFile(
    helper,
    `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv[2]==='version'){console.log(JSON.stringify({capabilities:['record_session_snapshot']}));process.exit(0)}
const out=process.argv[process.argv.indexOf('--output')+1];
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
if(line.startsWith('snapshot ')){const output=line.slice(9);fs.writeFileSync(output,'PNG fixture');setTimeout(()=>process.stderr.write(JSON.stringify({type:'snapshot',output,media_time_ms:123,recording_id:'test'})+'\\n'),30)}});
process.on('SIGINT',()=>{fs.writeFileSync(out,'video fixture');process.exit(0)});
`,
    { mode: 0o755 },
  );
  const recorder = createCaptureHelperVideoRecorder({ captureHelperPath: helper });
  const active = await recorder.start({
    target: { kind: 'window-id', windowId: '1' },
    outputPath: path.join(dir, 'out.mp4'),
    nodeId: 'run',
    record: 'full_run',
  });
  try {
    const output = path.join(dir, 'shot.png');
    const first = active.snapshot!(output);
    await assert.rejects(active.snapshot!(output), /already used/);
    const event = await first;
    assert.equal(event.media_time_ms, 123);
    assert.equal(await readFile(output, 'utf8'), 'PNG fixture');
    await assert.rejects(active.snapshot!('bad\npath'), /newline/);
  } finally {
    await active.stop();
  }
});

test('Android mirror fallback records the readiness reason and refuses wrong device identity', async () => {
  let starts = 0;
  const fallback = {
    name: 'fallback',
    async start() {
      starts++;
      return {
        async stop() {
          return { recorder: { name: 'fallback' } };
        },
      };
    },
  };
  const recorder = createAndroidMirrorVideoRecorder({
    serial: 'device-a',
    captureHelperPath: '/missing-capture-helper',
    fallback,
  });
  const result = await recorder.doctor!();
  assert.equal(result.ok, true);
  assert.match(result.message, /Primary recording path unavailable/);
  await assert.rejects(
    recorder.start({
      target: { kind: 'android-device', serial: 'other' },
      outputPath: '/tmp/unused',
      nodeId: 'run',
      record: 'full_run',
    }),
    /does not match/,
  );
  assert.equal(starts, 0);
  const active = await recorder.start({
    target: { kind: 'android-device', serial: 'device-a' },
    outputPath: '/tmp/unused',
    nodeId: 'run',
    record: 'full_run',
  });
  const stopped = await active.stop();
  assert.ok(stopped.recorder!.fallbackReason);
  assert.ok(result.message.includes(stopped.recorder!.fallbackReason!));
});

test('failed fallback readiness cannot be bypassed by retrying the recorder', async () => {
  let starts = 0;
  let checks = 0;
  const recorder = createAndroidMirrorVideoRecorder({
    serial: 'fixture',
    captureHelperPath: '/missing-capture-helper',
    fallback: {
      name: 'unready',
      async doctor() {
        checks++;
        return { ok: false, code: 'offline', message: 'Device is offline' };
      },
      async start() {
        starts++;
        throw new Error('Must not start an unready recorder');
      },
    },
  });
  const request = {
    target: { kind: 'android-device' as const, serial: 'fixture' },
    outputPath: '/tmp/unused',
    nodeId: 'proof',
    record: 'full_run' as const,
  };
  assert.equal((await recorder.doctor!()).ok, false);
  await assert.rejects(recorder.start(request), /Device is offline/);
  await assert.rejects(recorder.start(request), /Device is offline/);
  assert.equal(starts, 0);
  assert.equal(checks, 3);
});
