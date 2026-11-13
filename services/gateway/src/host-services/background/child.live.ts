import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { RawPoolJson } from '../../core/index.js';

import { ForkedBackgroundHost } from './client.js';
import type { BackgroundReadyMessage } from './protocol.js';

// Live check (not in the default suite: importing the child's graph under tsx takes seconds).
// Run from services/gateway:
//   TSX_TSCONFIG_PATH=tsconfig.json node --import tsx --test src/host-services/background/child.live.ts
// The real child.ts on a temp farm: one local slot (a git checkout on main) and one pending
// decision. Proves the forked entry imports, answers both operations, and dies with its parent.
const root = await mkdtemp(path.join(os.tmpdir(), 'background-child-'));
after(() => rm(root, { recursive: true, force: true }));
for (const directory of [
  'pool',
  'projects/proof/tasks/run-1',
  'home',
  'runs',
  'scripts',
  'services/gateway',
])
  await mkdir(path.join(root, directory), { recursive: true });
// The markers that make FARMSLOT_ROOT a farm root.
await writeFile(path.join(root, 'CLAUDE.md'), '# Background child fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
const checkout = path.join(root, 'checkout');
await mkdir(checkout);
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: checkout,
    stdio: 'ignore',
  });
git('init', '-q', '-b', 'main');
git('commit', '-q', '--allow-empty', '-m', 'root');
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({ name: 'proof', default_branch: 'main' }),
);
await writeFile(
  path.join(root, 'projects/proof/tasks/run-1/.pending_decision.json'),
  JSON.stringify({ id: 'smoke-decision', title: 'Choose', actions: [] }),
);
const pool: RawPoolJson = {
  machine: os.hostname(),
  host: 'localhost',
  ssh_user: os.userInfo().username,
  os: 'darwin',
  platform: 'cli',
  project: 'proof',
  slots: [{ id: 'smoke-slot', repo: checkout, session: 'smoke-slot' }],
};
await writeFile(path.join(root, 'pool/local.json'), JSON.stringify(pool));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_GATEWAY_BACKGROUND: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
};
await writeFile(path.join(root, 'status.json'), '{"slots":[]}\n');
const entry = fileURLToPath(new URL('./child.ts', import.meta.url));

test('the forked child probes a local machine and walks decisions', async () => {
  const background = new ForkedBackgroundHost({ env });
  after(() => background.stop());
  background.start();
  const rows = await background.request(
    'fleet.probeMachine',
    { entries: [{ pool, slotIdx: 0 }], ssh: [['localhost', 'local']] },
    { deadlineMs: 120_000 },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slot, 'smoke-slot');
  assert.equal(rows[0].ssh, 'LOCAL');
  assert.equal(rows[0].branch, 'main');
  const decisions = await background.request('decisions.scan', {}, { deadlineMs: 60_000 });
  assert.deepEqual(
    decisions.map((file) => file.decision.id),
    ['smoke-decision'],
  );
  const output = await background.request(
    'commands.read',
    { command: 'printf background-read', cwd: checkout, timeout: 5000 },
    { deadlineMs: 10000 },
  );
  assert.equal(output.stdout, 'background-read');
  assert.equal(output.exitCode, 0);
  const status = background.status();
  assert.equal(status.exec['commands.read']?.shell?.calls, 1);
  const abort = new AbortController();
  const marker = path.join(root, 'cancel-read-started');
  const heldRead = background.request(
    'commands.read',
    { command: `printf started > '${marker}'; sleep 60`, cwd: checkout, timeout: 5000 },
    { deadlineMs: 10000, signal: abort.signal },
  );
  const until = Date.now() + 2000;
  while (!(await import('node:fs')).existsSync(marker)) {
    assert.ok(Date.now() < until, 'child read command did not start');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  abort.abort();
  const cancelled = await heldRead;
  assert.equal(cancelled.exitCode, 130, 'abort reaches the child command closeout');
  assert.ok(status.exec['fleet.probeMachine']?.shell?.calls, 'probe commands are tallied');
  assert.equal(status.exec['decisions.scan'], undefined, 'the walk runs no commands');
  console.log(`[smoke] child rss after a refresh: ${status.rssBytes} bytes`);
  // The shared status file is never written by the child.
  assert.equal(await readFile(path.join(root, 'status.json'), 'utf8'), '{"slots":[]}\n');
});

test('the child starts no timers or watchers on import and exits with its parent', async () => {
  const child = fork(entry, [], {
    env,
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const ready = await new Promise<BackgroundReadyMessage>((resolve, reject) => {
    child.once('message', (message: BackgroundReadyMessage) => resolve(message));
    child.once('exit', (code) => reject(new Error(`child exited before ready (code ${code})`)));
  });
  console.log(
    `[smoke] child idle rss: ${ready.rssBytes} bytes; resources: ${ready.activeResources.join(', ')}`,
  );
  // Timers, intervals, file watchers and sockets would mean an import started background work.
  // Allowed: the IPC and stdio pipes, a pending fd close, and performance.ts's loop-delay
  // histogram, which is created at import but only enabled by the gateway server.
  const started = ready.activeResources.filter((resource) =>
    /Timeout|Immediate|FSEvent|StatWatcher|TCP|UDP|Signal|Process/.test(resource),
  );
  assert.deepEqual(started, [], 'no timers, watchers, sockets or processes after import');
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  child.disconnect();
  assert.equal(await exited, 0);
});

test('the shared IPC read stays in its inherited terminal-cleanup scope', async (t) => {
  const original = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const { backgroundHost } = await import('./client.js');
  const { readSlotCommand } = await import('../read-command.js');
  const { withCleanupSignal, drainCleanupCommands } = await import('../../core/cleanup-scope.js');
  const { makeVars } = await import('../../runners/test-fixtures.js');
  t.after(async () => {
    await backgroundHost.stop();
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  backgroundHost.start();
  await backgroundHost.request('decisions.scan', {}, { deadlineMs: 10000 });
  const commands = { pending: new Set<Promise<unknown>>(), unconfirmed: false };
  const cancellation = new AbortController();
  const marker = path.join(root, 'cleanup-read-started');
  const vars = makeVars({ host: 'localhost', machine: 'fixture', remoteRepo: checkout });
  const pending = withCleanupSignal(
    cancellation.signal,
    () =>
      readSlotCommand(vars, `printf started > '${marker}'; sleep 60`, { timeout: 5000, cwd: '/' }),
    commands,
  );
  try {
    const until = Date.now() + 2000;
    while (!(await import('node:fs')).existsSync(marker)) {
      assert.ok(Date.now() < until, 'cleanup-scoped child read did not start');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(commands.pending.size, 1);
    cancellation.abort();
    assert.equal((await pending).exitCode, 130);
    assert.equal(await drainCleanupCommands(commands), true);
    assert.equal(commands.pending.size, 0);
  } finally {
    cancellation.abort();
    await pending;
  }
});
