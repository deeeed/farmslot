// Real authenticated release RPC with an owned hanging recycle hook and a controlled clock.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const root = await mkdtemp('/tmp/fs-release-');
const load = (file) => import(pathToFileURL(path.join(source, file)).href);
const realTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const pause = () => new Promise((resolve) => realTimeout(resolve, 10));
const bounded = async (promise, timeoutMs = 3000) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = realTimeout(
          () => reject(new Error('release stayed pending past the controlled deadline')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    realClearTimeout(timer);
  }
};
const marker = path.join(root, 'hook-started.json');
let server, wss, client, requestOutcome, hookIdentity, primaryError;
const cleanupErrors = [];
const cleanup = async (operation) => {
  try {
    await operation();
  } catch (error) {
    cleanupErrors.push(error);
  }
};
const receipts = [];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};
try {
  for (const key of Object.keys(process.env))
    if (
      key.startsWith('FARMSLOT_') ||
      ['TMUX', 'TMUX_PANE', 'GW_URL', 'GATEWAY_URL', 'GATEWAY_TOKEN'].includes(key)
    )
      delete process.env[key];
  Object.assign(process.env, {
    NODE_TEST_CONTEXT: '1',
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(root, 'home'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
    FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
    FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
    FARMSLOT_CAPABILITY_STORE_FILE: path.join(root, 'capabilities.json'),
    FARMSLOT_ANALYTICS_DIR: path.join(root, 'analytics'),
    TMUX_TMPDIR: path.join(root, 'tm'),
    FARMSLOT_TMUX_SANDBOX: path.join(root, 'tm', `tmux-${process.getuid()}`, 'default'),
    SCREEN_CONTROL_SOCKET: path.join(root, 'screen.sock'),
  });
  for (const name of [
    'home',
    'pool',
    'projects/proof',
    'runs',
    'repo',
    'scripts',
    'services/gateway',
    'bin',
    `tm/tmux-${process.getuid()}`,
  ])
    await mkdir(path.join(root, name), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, 'CLAUDE.md'), '# Private release proof\n');
  await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
  await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
  await writeFile(
    path.join(root, 'bin/tmux'),
    '#!/bin/sh\necho "No tmux in release protocol proof" >&2\nexit 1\n',
    { mode: 0o700 },
  );
  process.env.PATH = path.join(root, 'bin') + path.delimiter + process.env.PATH;
  const { quoteRunnerArgValue: shellQuote } = await load('packages/slot-config/src/hooks.ts');
  const hook = path.join(root, 'hang.mjs');
  await writeFile(
    hook,
    `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid}));\nprocess.on('SIGTERM',()=>process.exit(0));\nsetInterval(()=>{},20);\n`,
  );
  await writeFile(
    path.join(root, 'projects/proof/project.json'),
    JSON.stringify({
      name: 'proof',
      default_branch: 'main',
      hooks: { recycle: `${shellQuote(process.execPath)} ${shellQuote(hook)}` },
    }),
  );
  await writeFile(
    path.join(root, 'pool/local.json'),
    JSON.stringify({
      machine: 'localhost',
      host: 'localhost',
      os: 'darwin',
      ssh_user: os.userInfo().username,
      platform: 'cli',
      project: 'proof',
      slots: [{ id: 'release-proof', repo: path.join(root, 'repo'), session: 'release-proof' }],
    }),
  );
  const git = (...args) =>
    execFileSync('git', ['-C', path.join(root, 'repo'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
  git('init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'repo/README.md'), 'Private release fixture\n');
  git('add', 'README.md');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'initial fixture',
  );
  git('remote', 'add', 'origin', path.join(root, 'repo'));
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  await load('services/gateway/src/runtime/mock-pty.test-support.ts');
  const core = await load('services/gateway/src/core/index.ts');
  const store = await load('services/gateway/src/runs/store.ts');
  const owner = store.createRun({
    project: 'proof',
    flowType: 'dev',
    ticketOrPr: 'PROOF-1',
    mode: 'validation',
    slotId: 'release-proof',
  });
  store.updateRun(owner.id, { status: 'failed', completedAt: new Date().toISOString() });
  await writeFile(
    path.join(root, 'status.json'),
    JSON.stringify({
      slots: [
        {
          slot: 'release-proof',
          lifecycle: 'held',
          phase: 'occupied',
          slot_epoch: 7,
          current_run_id: owner.id,
        },
      ],
    }),
  );
  const { createWebSocketServer } = await load('services/gateway/src/server.ts');
  const { createGatewayAuthRuntime } = await load('services/gateway/src/security/auth.ts');
  const { GatewayClient } = await load('packages/cli/src/gateway-client.ts');
  const { testGatewayIdentity } = await load('scripts/lib/test-gateway-identity-source.mts');
  const { replaySlotReclaimCheck } = await load('services/gateway/src/methods/run/replay-step.ts');
  const { isTerminalTeardownInFlight } = await load(
    'services/gateway/src/run-engine/terminal-teardown-registry.ts',
  );
  server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const token = testGatewayIdentity(process.env.FARMSLOT_HOME, url);
  wss = createWebSocketServer(
    server,
    createGatewayAuthRuntime({ FARMSLOT_HOME: process.env.FARMSLOT_HOME }),
  );
  client = await new GatewayClient({ url, timeout: 600000, credential: { token } }).connect();
  for (const successor of [false, true]) {
    if (successor)
      await core.updateSlotStatus('release-proof', {
        lifecycle: 'held',
        phase: 'occupied',
        slot_epoch: 7,
        current_run_id: owner.id,
        cleanup_run_id: null,
      });
    await rm(marker, { force: true });
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const request = client.call('slot.release', {
      slotId: 'release-proof',
      expectedRunId: owner.id,
      forceReset: true,
      preserveAgents: true,
      skipArtifacts: true,
    });
    requestOutcome = request.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const started = Date.now();
    let processRow;
    await bounded(
      (async () => {
        for (;;) {
          try {
            processRow = JSON.parse(await readFile(marker, 'utf8'));
            break;
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          const early = await Promise.race([requestOutcome, pause().then(() => null)]);
          if (early) throw early.error ?? new Error('release skipped the hanging hook');
        }
      })(),
      30_000,
    );
    assert.equal((await core.readSlotRow('release-proof')).phase, 'releasing');
    const birth = execFileSync('ps', ['-p', String(processRow.pid), '-o', 'lstart='], {
      encoding: 'utf8',
    }).trim();
    hookIdentity = { pid: processRow.pid, birth };
    if (successor)
      await core.claimSlotStatusIf('release-proof', () => true, {
        current_run_id: 'successor',
        foreign: 'preserve',
      });
    const before = await core.readSlotRow('release-proof');
    mock.timers.tick(300000);
    const outcome = await bounded(requestOutcome);
    assert(outcome.error);
    assert.match(outcome.error.message, /timed out after 300000ms/);
    const observed = await core.readSlotRow('release-proof');
    if (successor) assert.deepEqual(observed, before);
    else {
      assert.equal(observed.phase, 'occupied');
      assert.equal(observed.lifecycle, 'held');
      assert.equal(observed.current_run_id, owner.id);
      assert.equal(replaySlotReclaimCheck(observed, owner.id).ok, true);
    }
    assert.equal(isTerminalTeardownInFlight('release-proof'), false);
    await bounded(
      (async () => {
        while (alive(hookIdentity.pid)) await pause();
      })(),
    );
    assert.deepEqual(await core.readSlotRow('release-proof'), observed);
    receipts.push({
      method: 'slot.release',
      successor,
      status: 'PASS',
      started,
      observed,
      hookStopped: true,
    });
    hookIdentity = undefined;
    mock.timers.reset();
  }
  console.log(
    JSON.stringify({
      status: 'PASS',
      receipts,
      scope:
        'Authenticated RPC, real hanging project hook and durable writes; only the deadline clock is controlled. No model or native action.',
    }),
  );
} catch (error) {
  primaryError = error;
} finally {
  mock.timers.reset();
  await cleanup(async () => {
    if (hookIdentity && alive(hookIdentity.pid)) {
      assert.equal(
        execFileSync('ps', ['-p', String(hookIdentity.pid), '-o', 'lstart='], {
          encoding: 'utf8',
        }).trim(),
        hookIdentity.birth,
      );
      process.kill(hookIdentity.pid, 'SIGTERM');
    }
    if (requestOutcome) await bounded(requestOutcome);
  });
  await cleanup(async () => client?.close());
  if (wss)
    await cleanup(async () => {
      for (const peer of wss.clients) peer.terminate();
      await new Promise((resolve) => wss.close(resolve));
    });
  if (server?.listening)
    await cleanup(
      () =>
        new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
  if (!cleanupErrors.length) await rm(root, { recursive: true, force: true });
}

if (cleanupErrors.length)
  throw new AggregateError(
    [primaryError, ...cleanupErrors].filter(Boolean),
    `Release proof cleanup failed; retained ${root}`,
  );
if (primaryError) throw primaryError;
