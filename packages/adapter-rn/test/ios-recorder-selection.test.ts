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
if(args[0]==='version'){console.log(JSON.stringify({version:'test',capabilities:[]}));process.exit(0)}
if(args[0]==='list'){console.log(JSON.stringify({windows:cfg.windows}));process.exit(0)}
if(args[0]!=='record')process.exit(9);
fs.writeFileSync(path.join(dir,'helper.pid'),String(process.pid));
process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));
fs.writeFileSync(args[args.indexOf('--output')+1],'unit recording');
process.stderr.write(JSON.stringify({type:'record_ready',recording_id:'unit'})+'\\n');
setTimeout(()=>process.exit(90),3000);
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(dir, 'xcrun'),
    `#!${process.execPath}\n${common}
if(args.includes('list')){console.log(JSON.stringify({devices:{test:[{udid:'sim-1',name:'Own',state:'Booted'},{udid:'other',name:'Own-other',state:'Booted'}]}}));process.exit(0)}
if(args.includes('getenv')){console.log('sim-1');process.exit(0)}
if(!args.includes('recordVideo'))process.exit(8);
if(cfg.nativeBusy){console.error('A recording is already in progress');process.exit(16)}
fs.writeFileSync(path.join(dir,'native.pid'),String(process.pid));
fs.writeFileSync(args.at(-1),'ftypmoov');
process.on('SIGINT',()=>{if(!cfg.ignoreInterrupt)process.exit(0)});process.on('SIGTERM',()=>process.exit(0));
process.on('SIGUSR1',()=>fs.writeFileSync(path.join(dir,'alive'),'yes'));
process.stderr.write('Recording started\\n');setTimeout(()=>process.exit(90),3000);
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
