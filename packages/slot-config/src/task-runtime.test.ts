import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runTaskRuntime } from './task-runtime.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

/** A CLI installation with the files the task runtime imports through the CLI's own tsx. */
async function cliFixture(
  t: test.TestContext,
  init?: string,
): Promise<{ root: string; cli: string }> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'task-runtime-reap-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'packages/cli');
  for (const directory of ['bin', 'src/commands', 'src/onboarding'])
    await mkdir(path.join(cli, directory), { recursive: true });
  await symlink(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'));
  await writeFile(path.join(cli, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(cli, 'bin/farmslot.mjs'), '');
  await writeFile(path.join(cli, 'tsconfig.json'), '{}');
  await copyFile(
    path.join(repoRoot, 'packages/cli/src/envelope.ts'),
    path.join(cli, 'src/envelope.ts'),
  );
  await writeFile(
    path.join(cli, 'src/onboarding/env-file.ts'),
    'export function loadCheckoutEnv() {}',
  );
  await writeFile(
    path.join(cli, 'src/onboarding/workspace.ts'),
    'export function repoRoot() { return "/fixture"; } export function bootstrapFarmslotHome() {}',
  );
  await writeFile(
    path.join(cli, 'src/commands/hosted-task-init.ts'),
    init ??
      'export async function runHostedTaskInit(taskPath: string) { return { taskPath, pid: process.pid }; }',
  );
  return { root, cli };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(condition: () => boolean, limitMs: number): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return condition();
}

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
  await until(() => zombieChildren() - before === 0, 500);
  assert.equal(zombieChildren() - before, 0, `${runs} task runs left unreaped children`);
});

test('a task whose node dies stops itself and its subprocesses', { timeout: 30_000 }, async (t) => {
  const marker = path.join(await realpath(tmpdir()), `task-orphan-${process.pid}-${Date.now()}`);
  const pids: number[] = [];
  t.after(() => {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    return rm(marker, { force: true });
  });
  const { root, cli } = await cliFixture(
    t,
    `import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    export async function runHostedTaskInit() {
      // A tracked provider subprocess, as an init that runs tooling has.
      const child = spawn('sleep', ['30'], { stdio: 'ignore' });
      // And one whose leader exits at once, leaving a grandchild in its group.
      const leader = spawn('/bin/sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let grandchild = '';
      leader.stdout.on('data', (data) => (grandchild += data));
      await new Promise((resolve) => leader.once('close', resolve));
      fs.writeFileSync(${JSON.stringify(marker)} + '.tmp', JSON.stringify({ task: process.pid, child: child.pid, grandchild: Number(grandchild) }));
      fs.renameSync(${JSON.stringify(marker)} + '.tmp', ${JSON.stringify(marker)});
      // Long provider work keeps the event loop busy, as a 10-minute init does.
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }`,
  );
  // A stand-in node: it starts the task and is then killed without any cleanup.
  const node = spawn(
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
  if (node.pid) pids.push(node.pid);
  assert.ok(await until(() => existsSync(marker), 20_000), 'the task started');
  const { task, child, grandchild } = JSON.parse(readFileSync(marker, 'utf8')) as {
    task: number;
    child: number;
    grandchild: number;
  };
  pids.push(task, child, grandchild);
  node.kill('SIGKILL');
  assert.ok(await until(() => !alive(task), 5000), 'the task exits once its node is gone');
  assert.ok(await until(() => !alive(child), 5000), 'and stops its own subprocess');
  assert.ok(
    await until(() => !alive(grandchild), 5000),
    'and the group of a subprocess whose leader already exited',
  );
});

test('a descendant holding the task output does not delay the result', { timeout: 30_000 }, async (t) => {
  const held = path.join(await realpath(tmpdir()), `task-held-${process.pid}-${Date.now()}`);
  t.after(() => {
    if (existsSync(held)) {
      const pid = Number(readFileSync(held, 'utf8'));
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
    return rm(held, { force: true });
  });
  const { root, cli } = await cliFixture(
    t,
    `import { spawnSync } from 'node:child_process';
    export async function runHostedTaskInit(taskPath: string) {
      // Backgrounded by a synchronous script, so it is not a tracked task subprocess.
      spawnSync('/bin/sh', ['-c', 'sleep 30 & echo $! > ${held}'], { stdio: 'inherit' });
      return { taskPath };
    }`,
  );
  const started = Date.now();
  const result = await runTaskRuntime(
    {
      action: 'init',
      taskPath: path.join(root, 'task.json'),
      supportDir: root,
      env: { FARMSLOT_CLI: path.join(cli, 'bin/farmslot.mjs') },
    },
    root,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(Date.now() - started < 15_000, 'resolved without waiting for the descendant');
});

test('cancelling a task stops what it runs synchronously', { timeout: 30_000 }, async (t) => {
  const marker = path.join(await realpath(tmpdir()), `task-sync-${process.pid}-${Date.now()}`);
  t.after(() => {
    if (existsSync(marker)) {
      const pid = Number(readFileSync(marker, 'utf8'));
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
    return rm(marker, { force: true });
  });
  const { root, cli } = await cliFixture(
    t,
    `import { spawnSync } from 'node:child_process';
    export async function runHostedTaskInit() {
      // A synchronous probe the stop message cannot interrupt; only a forced end reaches it.
      spawnSync('/bin/sh', ['-c', 'echo $$ > ${marker}.tmp && mv ${marker}.tmp ${marker} && exec sleep 30'], { stdio: 'ignore' });
      return {};
    }`,
  );
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
  assert.ok(await until(() => existsSync(marker), 20_000), 'the probe started');
  const probe = Number(readFileSync(marker, 'utf8'));
  controller.abort();
  assert.equal((await pending).exitCode, 130);
  assert.ok(await until(() => !alive(probe), 5000), 'the synchronous probe is stopped with its task');
});
