import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JsonLineProcess } from './process.js';

const echo = `let arrival=0;require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line);process.stdout.write(JSON.stringify({id:message.id,result:{...message.params,arrival:++arrival}})+'\\n');
});`;

test('native startup queues protocol records without synchronous process reads', async (t) => {
  const original = childProcess.execFileSync;
  let scans = 0;
  const spy = t.mock.method(
    childProcess,
    'execFileSync',
    (...args: Parameters<typeof original>) => {
      if (args[0] === 'ps') scans++;
      return original(...args);
    },
  );
  syncBuiltinESMExports();
  let registered = false;
  const child = new JsonLineProcess(
    process.execPath,
    ['-e', echo],
    {
      cwd: process.cwd(),
      onSpawn: () => {
        registered = true;
      },
    },
    () => {},
    () => {},
  );
  try {
    assert.equal(registered, false, 'registration completed before the async identity read');
    const first = child.request('first', { position: 1 });
    const second = child.request('second', { position: 2 });
    assert.deepEqual(await Promise.all([first, second]), [
      { position: 1, arrival: 1 },
      { position: 2, arrival: 2 },
    ]);
    assert.equal(registered, true, 'protocol traffic preceded durable registration');
    assert.equal(scans, 0, 'native startup blocked its caller with synchronous ps');
  } finally {
    await child.close();
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test('cancelling while native identity is pending never opens the launch gate', async (t) => {
  const original = childProcess.execFile;
  let release: (() => void) | undefined;
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let held = false;
  const spy = t.mock.method(childProcess, 'execFile', (...args: Parameters<typeof original>) => {
    const callback = args.at(-1);
    if (typeof callback !== 'function') throw new Error('Process census callback missing');
    return original('ps', args[1], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!held) {
        held = true;
        release = () => {
          release = undefined;
          callback(error, stdout, stderr);
        };
        entered();
      } else callback(error, stdout, stderr);
    });
  });
  syncBuiltinESMExports();
  let registered = false;
  let confirmed = false;
  const child = new JsonLineProcess(
    process.execPath,
    ['-e', echo],
    {
      cwd: process.cwd(),
      onSpawn: () => {
        registered = true;
      },
    },
    () => assert.fail('cancelled native runner emitted protocol traffic'),
    (_error, stopped) => {
      confirmed = stopped;
    },
  );
  try {
    const rejected = assert.rejects(child.request('never-start', {}), /closed/);
    await reading;
    const closed = child.close();
    release!();
    await rejected;
    await closed;
    assert.equal(registered, false, 'cancelled startup registered or released its runner');
    assert.equal(confirmed, true, 'the owned gated root was not cleaned up');
  } finally {
    release?.();
    spy.mock.restore();
    syncBuiltinESMExports();
    await child.close();
  }
});

test('native identity read errors surface without releasing a runner', async (t) => {
  const failure = new Error('process metadata unavailable');
  const spy = t.mock.method(
    childProcess,
    'execFile',
    (...args: Parameters<typeof childProcess.execFile>) => {
      const callback = args.at(-1);
      if (typeof callback !== 'function') throw new Error('Process census callback missing');
      queueMicrotask(() => callback(failure, '', ''));
      return new childProcess.ChildProcess();
    },
  );
  syncBuiltinESMExports();
  let registered = false;
  const child = new JsonLineProcess(
    process.execPath,
    ['-e', echo],
    {
      cwd: process.cwd(),
      onSpawn: () => {
        registered = true;
      },
    },
    () => assert.fail('runner launched without process identity'),
    () => {},
  );
  t.after(async () => {
    if (child.child.exitCode === null && child.child.signalCode === null) {
      const exited = once(child.child, 'exit');
      child.child.kill('SIGKILL');
      await exited;
    }
  });
  const rejected = assert.rejects(child.request('never-start', {}), /process metadata unavailable/);
  try {
    await rejected;
    await assert.rejects(child.close(), /Native process ownership could not be established/);
    assert.equal(registered, false);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test('cancelling during registration never releases the native binary', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'native-registration-abort-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, 'started');
  const abort = new AbortController();
  const child = new JsonLineProcess(
    process.execPath,
    [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'native started');setInterval(()=>{},1000);`,
    ],
    { cwd: root, signal: abort.signal, onSpawn: () => abort.abort() },
    () => {},
    () => {},
  );
  try {
    await assert.rejects(child.request('never-start', {}), /closed/);
    await child.close();
    assert.equal(existsSync(marker), false, 'cancelled registration released the native binary');
  } finally {
    await child.close();
  }
});
