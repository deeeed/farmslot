// Manual process regression: node --import tsx <this-file>. No runner or tmux server is launched.
import assert from 'node:assert/strict';
import { type ChildProcess,execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { Run } from '@farmslot/protocol';

const entry = fileURLToPath(import.meta.url);
const source = path.resolve(path.dirname(entry), '../../../..');

async function child(phase: string, root: string): Promise<void> {
  assert.equal(process.env.FARMSLOT_BACKLOG_FILE, path.join(root, 'backlog.json'));
  assert.equal(process.env.FARMSLOT_DISPATCH_QUEUE_FILE, path.join(root, 'dispatch-queue.json'));
  await import('./gateway-status-process.js');
  const store = await import('../runs/store.js');
  const { withNativeReviewMutation, withNativeReviewOperation } =
    await import('../review/native-review-operation.js');
  let run: Run;
  if (phase === 'before') {
    run = store.createRun({ flowType: 'dev', project: 'isolated-review', ticketOrPr: 'PROOF-1' });
    run = store.updateRun(run.id, {
      slotId: 'owned-review',
      status: 'reviewing',
      steps: run.steps.map((step) => ({
        ...step,
        status: step.name === 'review' ? ('running' as const) : ('done' as const),
      })),
    });
    await store.persistRunNow(run, 'isolated review before restart');
    await writeFile(path.join(root, 'run-id'), run.id);
    await writeFile(
      path.join(root, '.farm-status.json'),
      JSON.stringify({
        checked_at: new Date().toISOString(),
        slots: [
          {
            slot: 'owned-review',
            current_run_id: run.id,
            slot_epoch: 76,
            lifecycle: 'busy',
            phase: 'working',
          },
        ],
      }),
    );
  } else {
    await store.loadAllRuns();
    const loaded = store.getRun((await readFile(path.join(root, 'run-id'), 'utf8')).trim());
    assert.ok(loaded, 'fresh gateway reloads the same reviewing run');
    run = loaded;
  }
  // Boot the real private gateway, without automatic dispatch, real runners or slot probes.
  await import('../index.js');
  const url = `http://127.0.0.1:${process.env.GATEWAY_PORT}/health`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) break;
    } catch (error) {
      if (
        !(error instanceof TypeError) ||
        !(error.cause instanceof Error) ||
        !('code' in error.cause) ||
        error.cause.code !== 'ECONNREFUSED'
      )
        throw error;
    }
    assert.ok(Date.now() < deadline, 'private gateway becomes healthy');
    await delay(50);
  }
  await withNativeReviewOperation(run, async () => {
    await withNativeReviewMutation(async () => {});
    process.send?.({ ready: true, pid: process.pid });
    await once(process, 'message');
    await withNativeReviewMutation(() => writeFile(path.join(root, 'review-result'), 'complete'));
    process.send?.({ completed: true });
  });
}

async function stop(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, 'exit');
  process.kill('SIGTERM');
  const timeout = setTimeout(() => process.kill('SIGKILL'), 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const started = performance.now();
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-status-restart-'));
  const sentinels = {
    backlog: path.join(root, 'external-backlog.json'),
    queue: path.join(root, 'external-queue.json'),
  };
  const sentinelBytes = JSON.stringify({ sentinel: 'external stores must remain untouched' });
  for (const file of Object.values(sentinels)) await writeFile(file, sentinelBytes);
  const inherited = {
    PATH: process.env.PATH,
    HOME: path.join(root, 'user-home'),
    FARMSLOT_BACKLOG_FILE: sentinels.backlog,
    FARMSLOT_DISPATCH_QUEUE_FILE: sentinels.queue,
  };
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(root, 'home'),
    FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
    TMPDIR: path.join(root, 'tmp'),
    TMUX_TMPDIR: path.join(root, 'tmux'),
    FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_BACKLOG_FILE: path.join(root, 'backlog.json'),
    FARMSLOT_DISPATCH_QUEUE_FILE: path.join(root, 'dispatch-queue.json'),
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    GATEWAY_HOST: '127.0.0.1',
    FARMSLOT_BRANCH_WATCHERS: '0',
    FARMSLOT_STARTUP_BRANCH_PREWARM: '0',
    TSX_TSCONFIG_PATH: path.join(source, 'services/gateway/tsconfig.json'),
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.FARMSLOT_TEST_STATUS_FILE;
  delete env.TMUX;
  delete env.TMUX_PANE;
  for (const name of ['home', 'runs', 'pool', 'projects', 'user-home', 'native', 'tmp', 'tmux'])
    await mkdir(path.join(root, name));
  await mkdir(path.join(root, 'scripts'));
  await mkdir(path.join(root, 'services/gateway'), { recursive: true });
  await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated regression fixture\n');
  await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\nexit 1\n');
  await writeFile(path.join(root, 'services/gateway/package.json'), '{"private":true}\n');
  execFileSync('git', ['init', '--initial-branch=proof'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', 'CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json'], {
    cwd: root,
    stdio: 'ignore',
  });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'chore: seed isolated restart fixture',
    ],
    { cwd: root, stdio: 'ignore' },
  );
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  const log = await open(path.join(root, 'gateway.log'), 'wx', 0o600);
  const start = (phase: string) =>
    spawn(process.execPath, ['--import', 'tsx', entry, '--child', phase, root], {
      cwd: source,
      env: { ...env, GATEWAY_PORT: String(port) },
      stdio: ['ignore', log.fd, log.fd, 'ipc'],
    });
  let gateway = start('before');
  const waitMessage = async (expected: 'ready' | 'completed') => {
    const message = once(gateway, 'message', { signal: AbortSignal.timeout(90_000) });
    const exited = once(gateway, 'exit').then(([code, signal]) => {
      throw new Error(`private gateway exited ${code}/${signal}; see ${root}/gateway.log`);
    });
    const [value] = await Promise.race([message, exited]);
    assert.ok(value && typeof value === 'object' && expected in value);
  };
  try {
    await waitMessage('ready');
    const firstPid = gateway.pid;
    await stop(gateway);
    gateway = start('after');
    await waitMessage('ready');
    assert.notEqual(gateway.pid, firstPid);
    const status = path.join(root, '.farm-status.json');
    const before = await readFile(status, 'utf8');
    const retained = JSON.parse(before).slots.find(
      (row: { slot: string }) => row.slot === 'owned-review',
    );
    assert.equal(
      retained.current_run_id,
      (await readFile(path.join(root, 'run-id'), 'utf8')).trim(),
    );
    assert.equal(retained.slot_epoch, 76);
    const writer = path.join(root, 'fixture-writer.test.mjs');
    await writeFile(
      writer,
      `import { writeFileSync } from 'node:fs';\nimport { resolveStatusFilePath } from ${JSON.stringify(new URL('./repo-root.js', import.meta.url).href)};\nwriteFileSync(resolveStatusFilePath(), JSON.stringify({ slots: [{ slot: 'slot-terminal-overlap' }] }));\n`,
    );
    const testProcess = spawn(process.execPath, ['--import', 'tsx', writer], {
      cwd: source,
      env,
      stdio: ['ignore', log.fd, log.fd],
    });
    const [code] = await once(testProcess, 'exit');
    assert.equal(code, 0);
    assert.equal(
      await readFile(status, 'utf8'),
      before,
      'direct test preserves the live lease across gateway restart',
    );
    const laneWriter = path.join(root, 'lane-writer.mjs');
    await writeFile(
      laneWriter,
      `import { resolveStatusFilePath } from ${JSON.stringify(new URL('./repo-root.js', import.meta.url).href)};\nresolveStatusFilePath();\n`,
    );
    const laneProcess = spawn(process.execPath, ['--import', 'tsx', laneWriter], {
      cwd: source,
      env,
      stdio: ['ignore', log.fd, 'pipe'],
    });
    let refusal = '';
    assert.ok(laneProcess.stderr);
    laneProcess.stderr.setEncoding('utf8');
    laneProcess.stderr.on('data', (chunk: string) => { refusal += chunk; });
    const [laneCode] = await once(laneProcess, 'exit');
    assert.notEqual(laneCode, 0, 'an ordinary lane script cannot resolve the shared store');
    assert.match(refusal, /requires gateway bootstrap/);
    assert.equal(await readFile(status, 'utf8'), before);
    gateway.send({ complete: true });
    await waitMessage('completed');
    assert.equal(await readFile(path.join(root, 'review-result'), 'utf8'), 'complete');
    for (const file of Object.values(sentinels))
      assert.equal(await readFile(file, 'utf8'), sentinelBytes, 'external store preserved');
    console.log(
      JSON.stringify({
        pass: true,
        elapsedMs: performance.now() - started,
        root,
        firstPid,
        restartedPid: gateway.pid,
        sameRunAndEpoch: true,
        noModelOrTmux: true,
      }),
    );
  } finally {
    await stop(gateway);
    await log.close();
    // Retain this owned fixture for inspection; the caller removes it after saving the proof.
    console.log(JSON.stringify({ ownedFixture: root, childrenStopped: true }));
  }
}

if (process.argv[2] === '--child') {
  await child(process.argv[3]!, process.argv[4]!);
} else {
  await main();
}
