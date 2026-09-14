import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import { NativeProcessTree } from './process-tree.js';
import { alive } from './storage.js';

test('a stalled census fails observation before child closure and cannot start overlapping scans', async (t) => {
  const tree = new NativeProcessTree(process.pid);
  const before = tree.snapshot();
  type ExecFile = typeof childProcess.execFile;
  let complete: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
  let scans = 0;
  const signals: string[] = [];
  const mock = t.mock.method(childProcess, 'execFile', (...args: Parameters<ExecFile>) => {
    scans++;
    complete = args.at(-1) as typeof complete;
    return {
      kill(signal: string) {
        signals.push(signal);
        return true;
      },
    } as ReturnType<ExecFile>;
  });
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors: Error[] = [];
  const stop = tree.observe((error) => errors.push(error));
  let stopNext: (() => void) | undefined;
  try {
    t.mock.timers.tick(100);
    assert.equal(scans, 1);
    t.mock.timers.tick(5000);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /deadline/);
    assert.deepEqual(signals, ['SIGKILL']);
    const nextErrors: Error[] = [];
    stopNext = tree.observe((error) => nextErrors.push(error));
    await Promise.resolve();
    assert.equal(nextErrors.length, 1, 'New owner waited silently behind a stalled census');
    t.mock.timers.tick(10000);
    assert.equal(scans, 1, 'Expired scan was replaced before its child closed');
    complete!(null, '', '');
    assert.deepEqual(
      tree.snapshot(),
      before,
      'Expired snapshot changed tracked process identities',
    );
    assert.equal(errors.length, 1);
  } finally {
    stop();
    stopNext?.();
    mock.mock.restore();
    syncBuiltinESMExports();
    t.mock.timers.reset();
  }
});

test('periodic scans are shared and an in-flight failure does not reach replaced subscribers', async (t) => {
  const tree = new NativeProcessTree(process.pid);
  const second = new NativeProcessTree(process.pid);
  let complete: ((error: Error, stdout: string, stderr: string) => void) | undefined;
  let scans = 0;
  type ExecFile = typeof childProcess.execFile;
  const mock = t.mock.method(childProcess, 'execFile', (...args: Parameters<ExecFile>) => {
    scans++;
    complete = args.at(-1) as typeof complete;
    // A controlled in-flight census; construction and cleanup use real OS metadata.
    return {} as ReturnType<ExecFile>;
  });
  syncBuiltinESMExports();
  let retiredErrors = 0;
  let nextErrors = 0;
  let liveErrors = 0;
  const retire = tree.observe(() => {
    retiredErrors++;
  });
  const stopSecond = second.observe(() => {
    liveErrors++;
  });
  let stopNext: (() => void) | undefined;
  try {
    const deadline = Date.now() + 5000;
    while (!complete && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(complete);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(scans, 1, 'Two trees or a slow census started overlapping scans');
    retire();
    stopNext = tree.observe(() => {
      nextErrors++;
    });
    complete(new Error('Census failed'), '', '');
    assert.equal(retiredErrors, 0);
    assert.equal(nextErrors, 0, 'A new registration consumed an older in-flight scan');
    assert.equal(liveErrors, 1, 'Census failure was hidden from its live owner');
  } finally {
    retire();
    stopSecond();
    stopNext?.();
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('signals revalidate targeted PID identity and propagate query failure', async (t) => {
  const root = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  await once(root, 'spawn');
  const tree = new NativeProcessTree(root.pid!);
  const original = childProcess.execFileSync;
  let fail = false;
  const mock = t.mock.method(
    childProcess,
    'execFileSync',
    (...args: Parameters<typeof original>) => {
      if (args[0] === 'ps' && Array.isArray(args[1]) && args[1].includes('-p')) {
        if (fail) throw new Error('Targeted identity unavailable');
        return `${root.pid} 1 ${root.pid} changed-start-time\n`;
      }
      return original(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    tree.terminate();
    assert.equal(alive(root.pid!), true, 'A reused PID identity was signalled');
    fail = true;
    assert.throws(() => tree.terminate(), /Targeted identity unavailable/);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
    tree.stop();
    if (alive(root.pid!)) await once(root, 'exit');
  }
});

test('cleanup retains a detached child after its title changes and parent exits', async () => {
  const childCode = `
    process.send(process.pid);
    process.on('message', () => { process.title = 'native-renamed-tool'; process.send('renamed'); });
    setInterval(() => {}, 1000);
  `;
  const root = spawn(
    process.execPath,
    [
      '-e',
      `
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    child.on('message', message => process.send(message));
    process.on('message', () => child.send('rename'));
  `,
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  let descendant: number | undefined;
  try {
    [descendant] = await once(root, 'message');
    assert.ok(typeof descendant === 'number');
    const tree = new NativeProcessTree(root.pid!);
    const renamed = once(root, 'message');
    root.send('rename');
    assert.equal((await renamed)[0], 'renamed');
    const exited = once(root, 'exit');
    root.kill('SIGKILL');
    await exited;
    assert.ok(alive(descendant));
    tree.stop();
    const deadline = Date.now() + 3_000;
    while (alive(descendant) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(alive(descendant), false, 'Detached renamed child survived cleanup');
    assert.equal(tree.empty(), true);
  } finally {
    if (root.pid && alive(root.pid)) root.kill('SIGKILL');
    if (descendant && alive(descendant)) process.kill(descendant, 'SIGKILL');
  }
});
