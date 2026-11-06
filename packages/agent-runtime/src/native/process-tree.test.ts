import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import { NativeProcessTree } from './process-tree.js';
import { alive } from './storage.js';

test('a failed persistence observer reports failure without starving another owner', async (t) => {
  const failedTree = new NativeProcessTree(process.pid);
  const healthyTree = new NativeProcessTree(process.pid);
  const errors: Error[] = [];
  let observed = false;
  const stopFailed = failedTree.observe(
    (error) => errors.push(error),
    () => {
      throw new Error('Journal write failed');
    },
  );
  const stopHealthy = healthyTree.observe(
    (error) => {
      throw error;
    },
    () => {
      observed = true;
    },
  );
  t.after(() => {
    stopFailed();
    stopHealthy();
  });
  const deadline = Date.now() + 5000;
  while (!errors.length || !observed) {
    assert.ok(Date.now() < deadline, 'both census owners must receive their outcome');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(errors[0]!.message, /Journal write failed/);
});

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
    t.mock.timers.tick(1000);
    assert.equal(scans, 1);
    assert.equal(mock.mock.calls[0]?.arguments[2]?.timeout, 30_000);
    // A census slower than 5 s on a loaded machine still owns its observers (ADR-057 Amendment 3).
    t.mock.timers.tick(29_999);
    assert.equal(errors.length, 0, 'a slow census failed its observers before its deadline');
    t.mock.timers.tick(1);
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
  const original = childProcess.execFile;
  let fail = false;
  const mock = t.mock.method(childProcess, 'execFile', (...args: Parameters<typeof original>) => {
    const complete = args.at(-1) as (error: Error | null, output: string, stderr: string) => void;
    return original('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8' }, () => {
      complete(
        fail ? new Error('Targeted identity unavailable') : null,
        `${root.pid} 1 ${root.pid} changed-start-time\n`,
        '',
      );
    });
  });
  syncBuiltinESMExports();
  try {
    await tree.terminate();
    assert.equal(alive(root.pid!), true, 'A reused PID identity was signalled');
    fail = true;
    await assert.rejects(() => tree.terminate(), /Targeted identity unavailable/);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
    await tree.stop();
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
    await tree.stop();
    const deadline = Date.now() + 3_000;
    while (alive(descendant) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(alive(descendant), false, 'Detached renamed child survived cleanup');
    assert.equal(await tree.empty(), true);
  } finally {
    if (root.pid && alive(root.pid)) root.kill('SIGKILL');
    if (descendant && alive(descendant)) process.kill(descendant, 'SIGKILL');
  }
});

test('retains stopped root observation without retaining live signal ownership', async (t) => {
  const root = 100039802;
  let census = `${process.pid} 1 ${process.pid} inspector\n${root} 100039801 100039801 original host birth\n`;
  const ps = t.mock.method(childProcess, 'execFileSync', () => census);
  const kill = t.mock.method(process, 'kill', () => {
    assert.fail('a departed root must never be signalled');
  });
  syncBuiltinESMExports();
  try {
    const tree = new NativeProcessTree(root);
    const original = tree.snapshot();
    census = `${process.pid} 1 ${process.pid} inspector\n`;
    await tree.capture();
    assert.equal(await tree.empty(), true);
    assert.deepEqual(tree.snapshot(), original);
    await tree.stop();
  } finally {
    ps.mock.restore();
    kill.mock.restore();
    syncBuiltinESMExports();
  }
});

test('shared background observers run at most one full census per second', async (t) => {
  const first = new NativeProcessTree(process.pid);
  const second = new NativeProcessTree(process.pid);
  const snapshot = first
    .snapshot()
    .map((entry) => `${entry.pid} ${entry.parent} ${entry.group} ${entry.identity}`)
    .join('\n');
  let scans = 0;
  const mock = t.mock.method(
    childProcess,
    'execFile',
    (...args: Parameters<typeof childProcess.execFile>) => {
      scans++;
      const callback = args.at(-1);
      if (typeof callback !== 'function') throw new Error('Census callback missing');
      queueMicrotask(() => callback(null, snapshot, ''));
      return new childProcess.ChildProcess();
    },
  );
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fail = (error: Error) => {
    throw error;
  };
  const stopFirst = first.observe(fail);
  const stopSecond = second.observe(fail);
  try {
    t.mock.timers.tick(999);
    assert.equal(scans, 0, 'Idle census started before its one-second interval');
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.equal(scans, 1, 'Observers must share the same census');
    for (let interval = 0; interval < 9; interval++) {
      t.mock.timers.tick(1000);
      await Promise.resolve();
    }
    assert.equal(scans, 10);
  } finally {
    stopFirst();
    stopSecond();
    mock.mock.restore();
    syncBuiltinESMExports();
    t.mock.timers.reset();
  }
});

test(
  'cleanup waits for an async batched census while the event loop stays available',
  { timeout: 5000 },
  async (t) => {
    const root = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    await once(root, 'spawn');
    const tree = new NativeProcessTree(root.pid!);
    const exec = childProcess.execFile;
    const sync = childProcess.execFileSync;
    let syncScans = 0;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: (() => void) | undefined;
    let first = true;
    t.mock.method(childProcess, 'execFileSync', (...args: Parameters<typeof sync>) => {
      syncScans++;
      return sync(...args);
    });
    t.mock.method(childProcess, 'execFile', (...args: Parameters<typeof exec>) => {
      const complete = args.at(-1) as (error: Error | null, output: string, stderr: string) => void;
      return exec(
        'ps',
        ['-axo', 'pid=,ppid=,pgid=,lstart='],
        { encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (first) {
            first = false;
            release = () => complete(error, stdout, stderr);
            entered();
          } else complete(error, stdout, stderr);
        },
      );
    });
    syncBuiltinESMExports();
    t.after(async () => {
      release?.();
      t.mock.restoreAll();
      syncBuiltinESMExports();
      if (root.pid && alive(root.pid)) process.kill(-root.pid, 'SIGKILL');
      if (root.exitCode === null && root.signalCode === null) await once(root, 'exit');
    });
    const stopped = tree.stop();
    assert.ok(stopped instanceof Promise);
    await ready;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(syncScans, 0, 'Cleanup ran a synchronous ps while waiting');
    assert.equal(alive(root.pid!), true, 'Unverified process was signalled');
    release!();
    await stopped;
    if (root.exitCode === null && root.signalCode === null) await once(root, 'exit');
    assert.equal(await tree.empty(), true);
  },
);

test('cleanup censuses cap concurrency and expired queued reads never spawn later', async (t) => {
  const tree = new NativeProcessTree(process.pid);
  type Complete = (error: Error | null, output: string, stderr: string) => void;
  const callbacks: Complete[] = [];
  const mock = t.mock.method(
    childProcess,
    'execFile',
    (...args: Parameters<typeof childProcess.execFile>) => {
      callbacks.push(args.at(-1) as Complete);
      return new childProcess.ChildProcess();
    },
  );
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reads = Promise.allSettled(Array.from({ length: 5 }, () => tree.capture()));
  try {
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(callbacks.length, 4);
    t.mock.timers.tick(5000);
    for (const complete of callbacks) complete(null, '', '');
    const settled = await reads;
    assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 4);
    const expired = settled.find((result) => result.status === 'rejected');
    assert.equal(expired?.status, 'rejected');
    if (expired?.status === 'rejected') assert.match(String(expired.reason), /deadline/);
    assert.equal(mock.mock.calls.length, 4, 'Expired census started after a slot became free');
  } finally {
    t.mock.timers.tick(5000);
    for (const complete of callbacks) complete(null, '', '');
    await reads;
    t.mock.timers.reset();
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});
