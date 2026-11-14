import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { parseTaskRuntimeRequest, runTaskRuntime } from '@farmslot/slot-config/task-runtime';

import {
  CASE,
  cliRun,
  env,
  repo,
  request,
  root,
  wireRequest,
} from './task-runtime.test-support.js';

// The CLI/thread parity pairs live in task-runtime-parity.live.ts
// (`yarn test:task-runtime-parity-live`). This keeps one real CLI start in the default suite.
test(
  'fresh init preserves task bytes, modes and provenance: CLI baseline',
  { timeout: CASE },
  () => {
    const before = cliRun(['internal', 'task-init', wireRequest()]);
    assert.equal(before.exitCode, 0, before.stdout + before.stderr);
  },
);

test('runtime transport rejects malformed actions, paths and environments', () => {
  assert.deepEqual(parseTaskRuntimeRequest(request), request);
  for (const invalid of [
    { action: 'mark' },
    { taskPath: '../task' },
    { env: { PATH: 17 } },
    { env: { 'bad key': 'value' } },
  ])
    assert.throws(
      () => parseTaskRuntimeRequest({ ...request, ...invalid }),
      /Invalid task runtime/,
    );
});

test('task threads keep machine providers, pack roots and module environment isolated', async () => {
  const fakeCli = path.join(root, 'environment-cli');
  fs.mkdirSync(path.join(fakeCli, 'src/commands'), { recursive: true });
  fs.mkdirSync(path.join(fakeCli, 'bin'));
  fs.writeFileSync(path.join(fakeCli, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(fakeCli, 'bin/farmslot.mjs'), '');
  fs.writeFileSync(path.join(fakeCli, 'tsconfig.json'), '{}');
  fs.mkdirSync(path.join(fakeCli, 'src/onboarding'));
  fs.writeFileSync(
    path.join(fakeCli, 'src/onboarding/env-file.ts'),
    'export function loadCheckoutEnv() {}',
  );
  fs.writeFileSync(
    path.join(fakeCli, 'src/onboarding/workspace.ts'),
    'export function repoRoot() { return "/fixture"; } export function bootstrapFarmslotHome() {}',
  );
  fs.copyFileSync(
    path.join(repo, 'packages/cli/src/envelope.ts'),
    path.join(fakeCli, 'src/envelope.ts'),
  );
  fs.writeFileSync(
    path.join(fakeCli, 'src/commands/hosted-task-init.ts'),
    `
    const provider = process.env.MM_HARNESS_PACKAGE_ROOT;
    export async function runHostedTaskInit() {
      process.env.MM_HARNESS_PACKAGE_ROOT = 'provider-loaded';
      return { pid: process.pid, provider, pool: process.env.FARMSLOT_POOL_DIR,
        projects: process.env.FARMSLOT_PROJECTS_DIR, root: process.env.FARMSLOT_ROOT ?? null,
        forceColor: process.env.FORCE_COLOR ?? null };
    }
  `,
  );
  const inherited: NodeJS.ProcessEnv = {
    ...process.env,
    FARMSLOT_CLI: path.join(fakeCli, 'bin/farmslot.mjs'),
    FARMSLOT_ROOT: '/wrong-root',
    MM_HARNESS_PACKAGE_ROOT: 'stale',
    FORCE_COLOR: '1',
  };
  delete inherited.FARMSLOT_POOL_DIR;
  delete inherited.FARMSLOT_PROJECTS_DIR;
  const parentProvider = process.env.MM_HARNESS_PACKAGE_ROOT;
  const results = await Promise.all(
    ['one', 'two'].map((provider) =>
      runTaskRuntime(
        {
          ...request,
          action: 'init',
          supportDir: '~/captured',
          env: {
            MM_HARNESS_PACKAGE_ROOT: provider,
            ...(provider === 'one' ? { FORCE_COLOR: '0' } : {}),
          },
        },
        root,
        inherited,
      ),
    ),
  );
  assert.deepEqual(
    results.map((result) => JSON.parse(result.stdout).data),
    ['one', 'two'].map((provider) => ({
      pid: process.pid,
      provider,
      pool: path.join(root, 'pool'),
      projects: path.join(inherited.HOME || os.homedir(), 'captured/projects'),
      root: null,
      forceColor: provider === 'one' ? '0' : null,
    })),
  );
  assert.equal(process.env.MM_HARNESS_PACKAGE_ROOT, parentProvider);
  assert.equal(inherited.MM_HARNESS_PACKAGE_ROOT, 'stale');
});

test('early cancellation returns confirmed exit 130', async () => {
  const controller = new AbortController();
  const pending = runTaskRuntime(request, root, env, controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(result.exitCode, 130);
  assert.match(result.stderr, /cancelled/);
});

test(
  'cancellation during provider work closes its subprocess before confirming',
  { timeout: 5000 },
  async (t) => {
    const fakeCli = path.join(root, 'environment-cli');
    const marker = path.join(root, 'running-child.json');
    fs.writeFileSync(
      path.join(fakeCli, 'src/commands/hosted-task-init.ts'),
      `
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    export async function runHostedTaskInit() {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100)'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: child.pid }));
      await new Promise(() => {});
    }
  `,
    );
    const controller = new AbortController();
    const pending = runTaskRuntime(
      { ...request, action: 'init', taskPath: '/task' },
      root,
      {
        ...env,
        FARMSLOT_CLI: path.join(fakeCli, 'bin/farmslot.mjs'),
      },
      controller.signal,
    );
    t.after(async () => {
      controller.abort();
      await pending;
    });
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(marker) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert(fs.existsSync(marker), 'provider reached its running child');
    const { pid } = JSON.parse(fs.readFileSync(marker, 'utf8'));
    controller.abort();
    assert.equal((await pending).exitCode, 130);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  },
);

test(
  'forced child closeout reaps the process before its thread exits',
  { timeout: 5000 },
  async (t) => {
    const fakeCli = path.join(root, 'environment-cli');
    const marker = path.join(root, 'term-resistant-child.json');
    const acknowledged = path.join(root, 'stop-acknowledged');
    fs.writeFileSync(
      path.join(fakeCli, 'src/commands/hosted-task-init.ts'),
      `
    import { spawn } from 'node:child_process';
    import { parentPort } from 'node:worker_threads';
    import fs from 'node:fs';
    export async function runHostedTaskInit() {
      parentPort.on('message', () => fs.writeFileSync(${JSON.stringify(acknowledged)}, 'stopping'));
      spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid}));process.on('SIGTERM',()=>{});setInterval(()=>{},100);`)}], { stdio: 'ignore' });
      await new Promise(() => {});
    }
  `,
    );
    const delay = globalThis.setTimeout;
    const waitFor = async (file: string) => {
      const deadline = Date.now() + 2000;
      while (!fs.existsSync(file) && Date.now() < deadline)
        await new Promise((resolve) => delay(resolve, 5));
      assert(fs.existsSync(file), file);
    };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    const pending = runTaskRuntime(
      { ...request, action: 'init', taskPath: '/task' },
      root,
      {
        ...env,
        FARMSLOT_CLI: path.join(fakeCli, 'bin/farmslot.mjs'),
      },
      controller.signal,
    );
    t.after(async () => {
      controller.abort();
      t.mock.timers.tick(10000);
      await pending;
    });
    await waitFor(marker);
    controller.abort();
    await waitFor(acknowledged);
    await new Promise((resolve) => delay(resolve, 5));
    t.mock.timers.tick(5000);
    assert.equal((await pending).exitCode, 130);
    const { pid } = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  },
);

test(
  'closed child groups are forgotten before a later cancellation',
  { timeout: 5000 },
  async (t) => {
    const fakeCli = path.join(root, 'environment-cli');
    const marker = path.join(root, 'closed-child.json');
    fs.writeFileSync(
      path.join(fakeCli, 'src/commands/hosted-task-init.ts'),
      `
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    export async function runHostedTaskInit() {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      await new Promise(resolve => child.once('close', resolve));
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: child.pid }));
      await new Promise(() => {});
    }
  `,
    );
    const controller = new AbortController();
    const pending = runTaskRuntime(
      { ...request, action: 'init', taskPath: '/task' },
      root,
      {
        ...env,
        FARMSLOT_CLI: path.join(fakeCli, 'bin/farmslot.mjs'),
      },
      controller.signal,
    );
    t.after(async () => {
      controller.abort();
      await pending;
    });
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(marker) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert(fs.existsSync(marker));
    const { pid } = JSON.parse(fs.readFileSync(marker, 'utf8'));
    const kill = process.kill;
    const retiredSignals: Parameters<typeof process.kill>[] = [];
    t.mock.method(process, 'kill', (...args: Parameters<typeof process.kill>) => {
      if (args[0] === -pid && args[1] !== 0) {
        retiredSignals.push(args);
        return true;
      }
      return kill(...args);
    });
    controller.abort();
    assert.equal((await pending).exitCode, 130);
    assert.deepEqual(retiredSignals, [], 'a retired group must never receive a later signal');
  },
);

test(
  'acknowledged closeout has a final bound when an escaped descendant holds a pipe',
  { timeout: 5000 },
  async (t) => {
    const fakeCli = path.join(root, 'environment-cli');
    const ready = path.join(root, 'escaped-descendant.json');
    const acknowledged = path.join(root, 'escaped-stop-ack');
    const exited = path.join(root, 'escaped-root-exited');
    const childCode = `
    const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{detached:true,stdio:['ignore',1,2]});
    child.unref();
    require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,escaped:child.pid}));
  `;
    fs.writeFileSync(
      path.join(fakeCli, 'src/commands/hosted-task-init.ts'),
      `
    import {spawn} from 'node:child_process';
    import {parentPort} from 'node:worker_threads';
    import fs from 'node:fs';
    export async function runHostedTaskInit() {
      parentPort.on('message',()=>fs.writeFileSync(${JSON.stringify(acknowledged)},'stopping'));
      const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}]);
      child.once('exit',()=>fs.writeFileSync(${JSON.stringify(exited)},'exited'));
      await new Promise(()=>{});
    }
  `,
    );
    const delay = globalThis.setTimeout;
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 1000;
      while (!condition() && Date.now() < deadline)
        await new Promise((resolve) => delay(resolve, 5));
      assert(condition(), 'expected closeout progress');
    };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const killCalls: Parameters<typeof process.kill>[] = [];
    const originalKill = process.kill;
    t.mock.method(process, 'kill', (...args: Parameters<typeof process.kill>) => {
      killCalls.push(args);
      return originalKill(...args);
    });
    const controller = new AbortController();
    let settled = false;
    const pending = runTaskRuntime(
      { ...request, action: 'init', taskPath: '/task' },
      root,
      {
        ...env,
        FARMSLOT_CLI: path.join(fakeCli, 'bin/farmslot.mjs'),
      },
      controller.signal,
    ).then((result) => {
      settled = true;
      return result;
    });
    t.after(async () => {
      controller.abort();
      t.mock.timers.tick(10000);
      if (fs.existsSync(ready)) {
        const { escaped } = JSON.parse(fs.readFileSync(ready, 'utf8'));
        try {
          process.kill(-escaped, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH')
            throw error;
        }
      }
      await pending;
    });
    await waitFor(() => fs.existsSync(ready));
    await waitFor(() => fs.existsSync(exited));
    const { pid } = JSON.parse(fs.readFileSync(ready, 'utf8'));
    await waitFor(() => killCalls.some(([target, signal]) => target === -pid && signal === 0));
    const beforeAbort = killCalls.length;
    controller.abort();
    await waitFor(() => fs.existsSync(acknowledged));
    t.mock.timers.tick(5000);
    await waitFor(() => fs.existsSync(exited));
    assert.equal(settled, false, 'the child close is still held by its escaped descendant');
    t.mock.timers.tick(5000);
    await waitFor(() => settled);
    assert.equal((await pending).exitCode, 130);
    assert.deepEqual(
      killCalls.slice(beforeAbort).filter(([target]) => target === -pid),
      [],
      'a reaped PID must not be probed or signalled after cancellation',
    );
  },
);
