import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { clearSimctlListings } from '../src/devices.js';
import { createIosSimulatorVideoRecorder } from '../src/simctl-video-recorder.js';

interface WindowFixture {
  id: number;
  app: string;
  title: string;
  onScreen: boolean;
}
interface FixtureOptions {
  windows: WindowFixture[];
  nativeBusy?: boolean;
  ignoreInterrupt?: boolean;
  noFirstFrame?: boolean;
  devices?: { udid: string; name: string; state: string }[];
}

function fixture(t: TestContext, options: FixtureOptions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-recorder-'));
  const savedPath = process.env.PATH;
  const savedHelper = process.env.CAPTURE_HELPER_PATH;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(options));
  const common = `const fs=require('node:fs'),path=require('node:path');
const dir=path.dirname(process.argv[1]),cfg=JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8')),args=process.argv.slice(2);
fs.appendFileSync(path.join(dir,'calls'),path.basename(process.argv[1])+' '+args.join(' ')+'\\n');`;
  fs.writeFileSync(
    path.join(dir, 'capture-helper'),
    `#!${process.execPath}\n${common}
if(args[0]==='doctor'){console.log(JSON.stringify({ok:true}));process.exit(0)}
if(args[0]==='version'){console.log(JSON.stringify({version:'test',capabilities:['record_session_snapshot']}));process.exit(0)}
if(args[0]==='list'){console.log(JSON.stringify({windows:cfg.windows}));process.exit(0)}
if(args[0]!=='record')process.exit(9);
fs.writeFileSync(path.join(dir,'helper.pid'),String(process.pid));
process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));
fs.writeFileSync(args[args.indexOf('--output')+1],'unit recording');
process.stderr.write(JSON.stringify({type:'record_ready',recording_id:'unit'})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const output=line.slice(9);fs.writeFileSync(output,'unit snapshot');process.stderr.write(JSON.stringify({type:'snapshot',output})+'\\n')});
setTimeout(()=>process.exit(90),3000);
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(dir, 'xcrun'),
    `#!${process.execPath}\n${common}
if(args.includes('list')){let devices=cfg.devices??[{udid:'sim-1',name:'Own',state:'Booted'},{udid:'other',name:'Own-other',state:'Booted'}];if(args.includes('booted'))devices=devices.filter(d=>d.state==='Booted');console.log(JSON.stringify({devices:{test:devices}}));process.exit(0)}
if(args.includes('getenv')){console.log('sim-1');process.exit(0)}
if(!args.includes('recordVideo'))process.exit(8);
if(cfg.nativeBusy){console.error('A recording is already in progress');process.exit(16)}
fs.writeFileSync(path.join(dir,'native.pid'),String(process.pid));
fs.writeFileSync(args.at(-1),'ftypmoov');
process.on('SIGINT',()=>{if(!cfg.ignoreInterrupt)process.exit(0)});process.on('SIGTERM',()=>process.exit(0));
process.on('SIGUSR1',()=>fs.writeFileSync(path.join(dir,'alive'),'yes'));
if(!cfg.noFirstFrame)process.stderr.write('Recording started\\n');setTimeout(()=>process.exit(90),3000);
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(dir, 'npm'),
    `#!/bin/sh\nprintf 'npm probe\n' >> '${dir}/calls'\nexit 1\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ''}`;
  process.env.CAPTURE_HELPER_PATH = path.join(dir, 'capture-helper');
  clearSimctlListings();
  t.after(() => {
    process.env.PATH = savedPath;
    if (savedHelper === undefined) delete process.env.CAPTURE_HELPER_PATH;
    else process.env.CAPTURE_HELPER_PATH = savedHelper;
    clearSimctlListings();
    for (const file of ['helper.pid', 'native.pid']) {
      const pidFile = path.join(dir, file);
      if (!fs.existsSync(pidFile)) continue;
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
      }).stdout;
      if (command.includes(dir)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
        }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    request: {
      target: { kind: 'simulator' as const, device: 'sim-1' },
      outputPath: path.join(dir, 'run.mp4'),
      nodeId: 'run',
      record: 'full_run' as const,
    },
  };
}

const visible: WindowFixture = { id: 42, app: 'Simulator', title: 'Own', onScreen: true };

test(
  'visible selected simulator records through capture-helper even while simctl is orphan-busy',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const f = fixture(t, { windows: [visible], nativeBusy: true });
    const active = await createIosSimulatorVideoRecorder('sim-1').start(f.request);
    await waitForFile(f.request.outputPath);
    const result = await active.stop();
    assert.equal(result.segments[0]?.recorder?.name, 'capture-helper');
    assert.deepEqual(result.segments[0]?.recorder?.target, {
      selector: 'simulator',
      value: 'sim-1',
    });
    assert.equal(result.segments[0]?.recorder?.mirrorWindowId, '42');
    assert.doesNotMatch(fs.readFileSync(path.join(f.dir, 'calls'), 'utf8'), /recordVideo/);
  },
);

for (const [name, windows] of [
  ['headless', []],
  ['another simulator', [{ ...visible, title: 'Own-other' }]],
  ['ambiguous windows', [visible, { ...visible, id: 43 }]],
] as const) {
  test(`${name} uses selected-device simctl and stops with SIGINT`, async (t) => {
    const f = fixture(t, { windows: [...windows] });
    const active = await createIosSimulatorVideoRecorder('sim-1').start(f.request);
    const result = await active.stop();
    assert.equal(result.segments[0]?.recorder?.name, 'simctl');
    assert.deepEqual(result.segments[0]?.recorder?.target, {
      selector: 'simulator',
      value: 'sim-1',
    });
    assert.match(fs.readFileSync(path.join(f.dir, 'calls'), 'utf8'), /io sim-1 recordVideo/);
  });
}

test('a headless stop timeout leaves the known recorder client alive instead of force-killing it', async (t) => {
  const f = fixture(t, { windows: [], ignoreInterrupt: true });
  const active = await createIosSimulatorVideoRecorder('sim-1', { stopTimeoutMs: 60 }).start(
    f.request,
  );
  await assert.rejects(active.stop(), /did not stop/);
  const pid = Number(fs.readFileSync(path.join(f.dir, 'native.pid'), 'utf8'));
  process.kill(pid, 'SIGUSR1');
  await waitForFile(path.join(f.dir, 'alive'));
});

function waitForFile(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = fs.watch(path.dirname(file), () => {
      if (fs.existsSync(file)) {
        clearTimeout(timer);
        watcher.close();
        resolve();
      }
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`Fixture never produced ${path.basename(file)}`));
    }, 1000);
    if (fs.existsSync(file)) {
      clearTimeout(timer);
      watcher.close();
      resolve();
    }
  });
}

test('constructing an unused recorder adds no helper processes', (t) => {
  const f = fixture(t, { windows: [] });
  createIosSimulatorVideoRecorder('sim-1');
  assert.equal(fs.existsSync(path.join(f.dir, 'calls')), false);
});

test('a shutdown namesake cannot supply the selected simulator window', async (t) => {
  const f = fixture(t, {
    windows: [visible],
    devices: [
      { udid: 'sim-1', name: 'Own', state: 'Booted' },
      { udid: 'shutdown', name: 'Own', state: 'Shutdown' },
    ],
  });
  const active = await createIosSimulatorVideoRecorder('sim-1').start(f.request);
  assert.equal((await active.stop()).segments[0]?.recorder?.name, 'simctl');
});

test('segment rotation retains the helper backend; a new recording may select native', async (t) => {
  const f = fixture(t, { windows: [visible] });
  const recorder = createIosSimulatorVideoRecorder('sim-1');
  const first = await recorder.start(f.request);
  assert.equal(typeof first.snapshot, 'function');
  await first.stop();
  fs.writeFileSync(
    path.join(f.dir, 'config.json'),
    JSON.stringify({ windows: [], nativeBusy: true }),
  );
  const rotated = await recorder.start({
    ...f.request,
    outputPath: path.join(f.dir, 'run-segment-1.mp4'),
  });
  assert.equal(typeof rotated.snapshot, 'function');
  await rotated.snapshot?.(path.join(f.dir, 'segment.png'));
  assert.equal(fs.readFileSync(path.join(f.dir, 'segment.png'), 'utf8'), 'unit snapshot');
  assert.equal((await rotated.stop()).segments[0]?.recorder?.name, 'capture-helper');
  fs.writeFileSync(path.join(f.dir, 'config.json'), JSON.stringify({ windows: [] }));
  const next = await recorder.start(f.request);
  assert.equal((await next.stop()).segments[0]?.recorder?.name, 'simctl');
});

test('startup timeout waits for SIGINT cleanup and reports a retained client PID', async (t) => {
  const f = fixture(t, { windows: [], noFirstFrame: true, ignoreInterrupt: true });
  const recorder = createIosSimulatorVideoRecorder('sim-1', {
    startTimeoutMs: 750,
    stopTimeoutMs: 60,
  });
  await assert.rejects(recorder.start(f.request), /first frame.*recorder PID \d+ is retained/s);
  const pid = Number(fs.readFileSync(path.join(f.dir, 'native.pid'), 'utf8'));
  process.kill(pid, 'SIGUSR1');
  await waitForFile(path.join(f.dir, 'alive'));
});

test('booted sentinel resolves the only booted simulator among available devices', async (t) => {
  const f = fixture(t, {
    windows: [visible],
    devices: [
      { udid: 'sim-1', name: 'Own', state: 'Booted' },
      { udid: 'shutdown', name: 'Other', state: 'Shutdown' },
    ],
  });
  const active = await createIosSimulatorVideoRecorder('booted').start({
    ...f.request,
    target: { kind: 'simulator', device: 'booted' },
  });
  assert.equal((await active.stop()).segments[0]?.recorder?.name, 'capture-helper');
});
