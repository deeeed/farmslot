import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import {
  cachedOnSuccess,
  killExitedLeaderGroup,
  parseTaskMessage,
  runTaskRuntime,
  withoutPreloads,
} from './task-runtime.js';
import { alive, cliFixture, taskPipe } from './task-runtime.test-support.js';

/** Exited children of this process that nobody waited for. */
function zombieChildren(): number {
  return execFileSync('ps', ['-axo', 'ppid=,stat='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([ppid, stat]) => Number(ppid) === process.pid && stat?.startsWith('Z')).length;
}

// Each run loads the CLI through tsx, whose loader starts an esbuild service child.
// Run inside a worker thread, that child outlived the thread and was never reaped.
test('task runs leave no unreaped child processes behind', { timeout: 60_000 }, async (t) => {
  const { root, cli } = await cliFixture(t);
  const runs = 3;
  const before = zombieChildren();
  for (let run = 0; run < runs; run++) {
    const result = await runTaskRuntime(
      {
        action: 'init',
        taskPath: path.join(root, `task-${run}.json`),
        supportDir: root,
        env: { FARMSLOT_CLI: path.join(cli, 'bin/farmslot.mjs') },
      },
      root,
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.data.taskPath, path.join(root, `task-${run}.json`));
  }
  // The task itself is reaped before 'close'; a leaked esbuild would stay a zombie.
  assert.equal(zombieChildren() - before, 0, `${runs} task runs left unreaped children`);
});

test("a reaped leader's group is killed only while no live process holds its id", () => {
  const calls: [number, NodeJS.Signals | 0][] = [];
  const kill =
    (probe: 'alive' | 'ESRCH' | 'EPERM') => (pid: number, signal: NodeJS.Signals | 0) => {
      calls.push([pid, signal]);
      if (signal === 0 && probe !== 'alive') throw Object.assign(new Error(probe), { code: probe });
      return true;
    };
  // The id was reused by a live process (ours to signal or not): its group is not ours.
  assert.equal(killExitedLeaderGroup(4242, kill('alive')), false);
  assert.equal(killExitedLeaderGroup(4242, kill('EPERM')), false);
  assert.deepEqual(calls, [
    [4242, 0],
    [4242, 0],
  ]);
  calls.length = 0;
  // Nothing holds the id: what is left in the group is the reaped task's.
  assert.equal(killExitedLeaderGroup(4242, kill('ESRCH')), true);
  assert.deepEqual(calls, [
    [4242, 0],
    [-4242, 'SIGKILL'],
  ]);
});

test('a task can name only a real subprocess group, never the node’s own or every process', () => {
  // Signalled negated: 0 is the node's own group, 1 (-1) every process it may signal.
  // 777 stands for the node's own process group, which need not be its pid.
  for (const pid of [0, -0, 1, -4242, 1.5, Number.NaN, Infinity, process.pid, 777, '4242'])
    assert.equal(
      parseTaskMessage({ type: 'task-child', pid }, 777),
      undefined,
      `pid ${String(pid)}`,
    );
  assert.deepEqual(parseTaskMessage({ type: 'task-child-exit', pid: 4242 }, 777), {
    type: 'task-child-exit',
    pid: 4242,
  });
  assert.equal(parseTaskMessage({ stdout: '', stderr: '', exitCode: 0.5 }, 777), undefined);
  assert.deepEqual(parseTaskMessage({ stdout: 'x', stderr: '', exitCode: 3 }, 777), {
    stdout: 'x',
    stderr: '',
    exitCode: 3,
  });
});

/**
 * Fixture code that runs once the task's result went out: `then`, and a tracked `true` whose
 * exit the task reports on the same ordered channel as the result, after it. The marker's
 * pid is written to the pipe as "marker <pid>".
 */
const afterResult = (then = '') => `
      const unref = process.channel.unref.bind(process.channel);
      process.channel.unref = () => {
        unref();
        ${then}
        const marker = spawn('true', [], { stdio: 'ignore' });
        fs.writeSync(pipe, 'marker ' + marker.pid + '\\n');
      };`;

/**
 * Watches this process's group probes. `read(line)` resolves once the runtime probed the
 * marker named in `line`: it reads that child's exit only after the task's result.
 */
function resultWatch(t: test.TestContext) {
  const kill = t.mock.method(process, 'kill');
  return async (line: string) => {
    const marker = Number(line.replace(/^marker /, ''));
    assert.ok(marker > 1, line);
    while (!kill.mock.calls.some(({ arguments: [pid, signal] }) => pid === -marker && signal === 0))
      await new Promise((resolve) => setTimeout(resolve, 10));
  };
}

/** A stand-in node: it starts the task and can then be killed without any cleanup. */
function standInNode(root: string, cli: string) {
  return spawn(
    process.execPath,
    [
      ...process.execArgv,
      '--input-type=module',
      '-e',
      `const { runTaskRuntime } = await import(${JSON.stringify(path.join(import.meta.dirname, 'task-runtime.ts'))});
      await runTaskRuntime({ action: 'init', taskPath: ${JSON.stringify(path.join(root, 'task.json'))}, supportDir: ${JSON.stringify(root)}, env: { FARMSLOT_CLI: ${JSON.stringify(path.join(cli, 'bin/farmslot.mjs'))} } }, ${JSON.stringify(root)});`,
    ],
    { stdio: 'ignore' },
  );
}

test('a task whose node dies stops itself and its subprocesses', { timeout: 90_000 }, async (t) => {
  const pipe = await taskPipe(t);
  const pids: number[] = [];
  t.after(() => {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
  const { root, cli } = await cliFixture(
    t,
    `import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    export async function runHostedTaskInit() {
      // The task and every subprocess below hold the pipe: it ends when all of them have exited.
      const pipe = fs.openSync(${JSON.stringify(pipe.path)}, 'w');
      // A tracked provider subprocess, as an init that runs tooling has.
      const child = spawn('sleep', ['600'], { stdio: ['ignore', 'ignore', 'ignore', pipe] });
      // And one whose leader exits at once, leaving a grandchild in its group.
      const leader = spawn('/bin/sh', ['-c', 'sleep 600 >/dev/null 2>&1 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore', pipe] });
      let grandchild = '';
      leader.stdout.on('data', (data) => (grandchild += data));
      await new Promise((resolve) => leader.once('close', resolve));
      fs.writeSync(pipe, JSON.stringify({ task: process.pid, child: child.pid, grandchild: Number(grandchild) }) + '\\n');
      // Long provider work keeps the event loop busy, as a 10-minute init does.
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }`,
  );
  const node = standInNode(root, cli);
  if (node.pid) pids.push(node.pid);
  const started = JSON.parse(await pipe.line()) as {
    task: number;
    child: number;
    grandchild: number;
  };
  pids.push(started.task, started.child, started.grandchild);
  node.kill('SIGKILL');
  // The task, its subprocess and the grandchild of the leaderless group have all exited.
  await pipe.closed();
});

test(
  'a task blocked in a synchronous call when its node dies still stops',
  { timeout: 90_000 },
  async (t) => {
    const pipe = await taskPipe(t);
    const pids: number[] = [];
    t.after(() => {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    });
    const { root, cli } = await cliFixture(
      t,
      `import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    export async function runHostedTaskInit() {
      // The task and its synchronous subprocess hold the pipe: it ends when both have exited.
      const pipe = fs.openSync(${JSON.stringify(pipe.path)}, 'w');
      fs.writeSync(pipe, String(process.pid) + '\\n');
      // The main thread is blocked here, so it never sees its node's disconnect.
      spawnSync('/bin/sh', ['-c', 'echo $$ >&3; exec sleep 600'], { stdio: ['ignore', 'ignore', 'ignore', pipe] });
    }`,
    );
    const node = standInNode(root, cli);
    if (node.pid) pids.push(node.pid);
    pids.push(Number(await pipe.line()), Number(await pipe.line()));
    node.kill('SIGKILL');
    // The task and the call it was blocked in have both exited.
    await pipe.closed();
  },
);

test(
  'a descendant holding the task output neither delays nor loses the result',
  { timeout: 60_000 },
  async (t) => {
    const pipe = await taskPipe(t);
    let descendant = 0;
    t.after(() => {
      if (descendant && alive(descendant)) process.kill(descendant, 'SIGKILL');
    });
    const { root, cli } = await cliFixture(
      t,
      `import fs from 'node:fs';
    import { spawn, spawnSync } from 'node:child_process';
    export async function runHostedTaskInit(taskPath: string) {
      // Only the task holds the pipe, so it ends when the task exits.
      const pipe = fs.openSync(${JSON.stringify(pipe.path)}, 'w');
      // Backgrounded by a synchronous script, so it is not a tracked task subprocess.
      spawnSync('/bin/sh', ['-c', 'sleep 600 3>&- & echo $! >&3'], { stdio: ['inherit', 'inherit', 'inherit', pipe] });
      ${afterResult()}
      return { taskPath };
    }`,
    );
    const resultRead = resultWatch(t);
    const controller = new AbortController();
    const pending = runTaskRuntime(
      {
        action: 'init',
        taskPath: path.join(root, 'task.json'),
        supportDir: root,
        env: { FARMSLOT_CLI: path.join(cli, 'bin/farmslot.mjs') },
      },
      root,
      process.env,
      controller.signal,
    );
    descendant = Number(await pipe.line());
    await resultRead(await pipe.line());
    // The node read the result and the task exited; the descendant still holds its output,
    // so this cancel lands in the drain window. Without the drain the result would wait for
    // the descendant's 600 s; without the delivered-result guard the cancel would replace it.
    await pipe.closed();
    controller.abort();
    const result = await pending;
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(alive(descendant), 'the result came back while the descendant still ran');
  },
);

test('a task that crashes still has its subprocesses stopped', { timeout: 90_000 }, async (t) => {
  const pipe = await taskPipe(t);
  const pids: number[] = [];
  t.after(() => {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
  const { root, cli } = await cliFixture(
    t,
    `import fs from 'node:fs';
    import { spawn, spawnSync } from 'node:child_process';
    export async function runHostedTaskInit() {
      // The task and both subprocesses hold the pipe: it ends when all of them have exited.
      const pipe = fs.openSync(${JSON.stringify(pipe.path)}, 'w');
      // A tracked subprocess in its own group.
      const child = spawn('sleep', ['600'], { stdio: ['ignore', 'ignore', 'ignore', pipe] });
      // An untracked one in the task's own group, holding the task's output.
      const untracked = spawnSync('/bin/sh', ['-c', 'sleep 600 >&2 & echo $!'], { stdio: ['ignore', 'pipe', 'inherit', pipe] });
      fs.writeSync(pipe, JSON.stringify({ child: child.pid, untracked: Number(untracked.stdout) }) + '\\n');
      setTimeout(() => { throw new Error('provider crashed'); }, 50);
      await new Promise(() => {});
    }`,
  );
  // Timers are faked so the output drain never ends: the result must not depend on it.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = runTaskRuntime(
    {
      action: 'init',
      taskPath: path.join(root, 'task.json'),
      supportDir: root,
      env: { FARMSLOT_CLI: path.join(cli, 'bin/farmslot.mjs') },
    },
    root,
  );
  let settled = false;
  const outcome = pending.finally(() => (settled = true));
  const started = JSON.parse(await pipe.line()) as { child: number; untracked: number };
  pids.push(started.child, started.untracked);
  // The untracked subprocess holds the task's output and the drain never ends, so both
  // subprocesses stop only if the task's group was killed as it exited.
  await pipe.closed();
  // Advance the runtime's own short waits (the closeout's group census) until it settles.
  while (!settled) {
    t.mock.timers.tick(100);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.notEqual((await outcome).exitCode, 0);
});

test(
  'a task that delivered but did not exit cleanly has its own group stopped',
  { timeout: 90_000 },
  async (t) => {
    const pipe = await taskPipe(t);
    let leftover = 0;
    t.after(() => {
      if (leftover && alive(leftover)) process.kill(leftover, 'SIGKILL');
    });
    const { root, cli } = await cliFixture(
      t,
      `import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    export async function runHostedTaskInit(taskPath: string) {
      // The task and its untracked leftover hold the pipe: it ends when both have exited.
      const pipe = fs.openSync(${JSON.stringify(pipe.path)}, 'w');
      spawnSync('/bin/sh', ['-c', 'sleep 600 >/dev/null 2>&1 & echo $! >&3'], { stdio: ['ignore', 'ignore', 'ignore', pipe] });
      // Provider teardown fails after the result went out.
      process.exitCode = 3;
      return { taskPath };
    }`,
    );
    const pending = runTaskRuntime(
      {
        action: 'init',
        taskPath: path.join(root, 'task.json'),
        supportDir: root,
        env: { FARMSLOT_CLI: path.join(cli, 'bin/farmslot.mjs') },
      },
      root,
    );
    leftover = Number(await pipe.line());
    assert.equal((await pending).exitCode, 0, 'the delivered result stands');
    await pipe.closed();
  },
);

test(
  'output past the bound after a delivered result still fails the run',
  { timeout: 90_000 },
  async (t) => {
    const pipe = await taskPipe(t);
    const { root, cli } = await cliFixture(
      t,
      `import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    export async function runHostedTaskInit(taskPath: string) {
      const pipe = fs.openSync(${JSON.stringify(pipe.path)}, 'w');
      // After the result went out, more than the 8 MiB bound on stdout.
      ${afterResult("process.stdout.write('x'.repeat(9 * 1024 * 1024));")}
      return { taskPath };
    }`,
    );
    const pending = runTaskRuntime(
      {
        action: 'init',
        taskPath: path.join(root, 'task.json'),
        supportDir: root,
        env: { FARMSLOT_CLI: path.join(cli, 'bin/farmslot.mjs') },
      },
      root,
    );
    const result = await pending;
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /maxBuffer exceeded/);
  },
);

test(
  'a second result past the bound after delivery still fails the run',
  { timeout: 90_000 },
  async (t) => {
    const pipe = await taskPipe(t);
    const { root, cli } = await cliFixture(
      t,
      `import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    export async function runHostedTaskInit(taskPath: string) {
      const pipe = fs.openSync(${JSON.stringify(pipe.path)}, 'w');
      // Provider code sends its own result-shaped message, past the bound, after the result.
      ${afterResult("process.send({ stdout: 'x'.repeat(9 * 1024 * 1024), stderr: '', exitCode: 0 });")}
      return { taskPath };
    }`,
    );
    const result = await runTaskRuntime(
      {
        action: 'init',
        taskPath: path.join(root, 'task.json'),
        supportDir: root,
        env: { FARMSLOT_CLI: path.join(cli, 'bin/farmslot.mjs') },
      },
      root,
    );
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /maxBuffer exceeded/);
  },
);

test('NODE_OPTIONS reaches a task without its module preloads', () => {
  assert.equal(
    withoutPreloads(
      '--max-old-space-size=8192 --import tsx -r ./hook.cjs --loader=x --require=y --trace-warnings',
    ),
    '--max-old-space-size=8192 --trace-warnings',
  );
  assert.equal(withoutPreloads('--import=tsx'), '');
});

test('a group read that fails is tried again rather than cached', async () => {
  let reads = 0;
  const read = cachedOnSuccess(async () => {
    reads++;
    if (reads === 1) throw new Error('ps: fork failed');
    return 4242;
  });
  await assert.rejects(read(), /fork failed/);
  assert.equal(await read(), 4242);
  assert.equal(await read(), 4242);
  assert.equal(reads, 2);
});

test(
  'a cancel after the task exited still stops its tracked subprocess',
  { timeout: 90_000 },
  async (t) => {
    const pipe = await taskPipe(t);
    let child = 0;
    t.after(() => {
      if (child && alive(child)) process.kill(child, 'SIGKILL');
    });
    const { root, cli } = await cliFixture(
      t,
      `import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    export async function runHostedTaskInit(taskPath: string) {
      // The task and its subprocess hold the pipe: it ends when both have exited.
      const pipe = fs.openSync(${JSON.stringify(pipe.path)}, 'w');
      // Tracked, holding the task's stdout, and not keeping the task alive.
      const child = spawn('sleep', ['600'], { stdio: ['ignore', 'inherit', 'ignore', pipe] });
      child.unref();
      fs.writeSync(pipe, JSON.stringify({ task: process.pid, child: child.pid }) + '\\n');
      ${afterResult()}
      return { taskPath };
    }`,
    );
    const resultRead = resultWatch(t);
    const controller = new AbortController();
    const pending = runTaskRuntime(
      {
        action: 'init',
        taskPath: path.join(root, 'task.json'),
        supportDir: root,
        env: { FARMSLOT_CLI: path.join(cli, 'bin/farmslot.mjs') },
      },
      root,
      process.env,
      controller.signal,
    );
    const started = JSON.parse(await pipe.line()) as { task: number; child: number };
    child = started.child;
    await resultRead(await pipe.line());
    // The runtime saw the task exit in the same callback that reaped it.
    while (alive(started.task)) await new Promise((resolve) => setTimeout(resolve, 10));
    // The subprocess holds the output, so this lands in the drain window.
    controller.abort();
    assert.equal((await pending).exitCode, 0, 'the delivered result stands');
    await pipe.closed();
  },
);

test(
  'a result send on a closed channel is not a delivery: the task stops',
  { timeout: 90_000 },
  async (t) => {
    const pipe = await taskPipe(t);
    let child = 0;
    t.after(() => {
      if (child && alive(child)) process.kill(child, 'SIGKILL');
    });
    const { root, cli } = await cliFixture(
      t,
      `import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    export async function runHostedTaskInit(taskPath: string) {
      // The task and its subprocess hold the pipe: it ends when both have exited.
      const pipe = fs.openSync(${JSON.stringify(pipe.path)}, 'w');
      const child = spawn('sleep', ['600'], { stdio: ['ignore', 'ignore', 'ignore', pipe] });
      fs.writeSync(pipe, String(child.pid) + '\\n');
      // The channel reads closed when the result goes out.
      Object.defineProperty(process, 'connected', { configurable: true, get: () => false });
      return { taskPath };
    }`,
    );
    const pending = runTaskRuntime(
      {
        action: 'init',
        taskPath: path.join(root, 'task.json'),
        supportDir: root,
        env: { FARMSLOT_CLI: path.join(cli, 'bin/farmslot.mjs') },
      },
      root,
    );
    child = Number(await pipe.line());
    assert.notEqual((await pending).exitCode, 0, 'no result arrived');
    await pipe.closed();
  },
);

test(
  'a subprocess started after the result is still stopped by a cancel',
  { timeout: 90_000 },
  async (t) => {
    const pipe = await taskPipe(t);
    let child = 0;
    t.after(() => {
      if (child && alive(child)) process.kill(child, 'SIGKILL');
    });
    const { root, cli } = await cliFixture(
      t,
      `import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    export async function runHostedTaskInit(taskPath: string) {
      // The task and its subprocess hold the pipe: it ends when both have exited.
      const pipe = fs.openSync(${JSON.stringify(pipe.path)}, 'w');
      // Provider work that goes on after the result went out.
      ${afterResult(`
        const child = spawn('sleep', ['600'], { stdio: ['ignore', 'ignore', 'ignore', pipe] });
        fs.writeSync(pipe, String(child.pid) + '\\n');`)}
      return { taskPath };
    }`,
    );
    const resultRead = resultWatch(t);
    const controller = new AbortController();
    const pending = runTaskRuntime(
      {
        action: 'init',
        taskPath: path.join(root, 'task.json'),
        supportDir: root,
        env: { FARMSLOT_CLI: path.join(cli, 'bin/farmslot.mjs') },
      },
      root,
      process.env,
      controller.signal,
    );
    child = Number(await pipe.line());
    await resultRead(await pipe.line());
    controller.abort();
    assert.equal((await pending).exitCode, 0, 'the delivered result stands');
    await pipe.closed();
  },
);

test(
  'cancelling a task that delivered while its subprocess runs keeps the result and stops it',
  { timeout: 90_000 },
  async (t) => {
    const pipe = await taskPipe(t);
    const pids: number[] = [];
    t.after(() => {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    });
    const { root, cli } = await cliFixture(
      t,
      `import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    export async function runHostedTaskInit(taskPath: string) {
      // The task and its subprocess hold the pipe: it ends when both have exited.
      const pipe = fs.openSync(${JSON.stringify(pipe.path)}, 'w');
      // A tracked subprocess the task does not wait for keeps it alive after its result.
      const child = spawn('sleep', ['600'], { stdio: ['ignore', 'ignore', 'ignore', pipe] });
      fs.writeSync(pipe, JSON.stringify({ task: process.pid, child: child.pid }) + '\\n');
      ${afterResult()}
      return { taskPath };
    }`,
    );
    const resultRead = resultWatch(t);
    const controller = new AbortController();
    const pending = runTaskRuntime(
      {
        action: 'init',
        taskPath: path.join(root, 'task.json'),
        supportDir: root,
        env: { FARMSLOT_CLI: path.join(cli, 'bin/farmslot.mjs') },
      },
      root,
      process.env,
      controller.signal,
    );
    const started = JSON.parse(await pipe.line()) as { task: number; child: number };
    pids.push(started.task, started.child);
    await resultRead(await pipe.line());
    controller.abort();
    // Without the stop the task would run until its subprocess's 600 s end.
    assert.equal((await pending).exitCode, 0);
    await pipe.closed();
  },
);
