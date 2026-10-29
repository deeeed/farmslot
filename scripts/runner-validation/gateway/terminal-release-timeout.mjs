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
const stopping = new AbortController();
const earlyInterruption = process.argv.includes('--interrupt-before-hook-identity');
const expectedInterruption = earlyInterruption || process.argv.includes('--interrupt-at-hook');
const refreshHold = process.argv.includes('--refresh-unconfirmed-hold');
const terminate = () => stopping.abort(new Error('release proof interrupted by SIGTERM'));
const interrupt = () => stopping.abort(new Error('release proof interrupted by SIGINT'));
process.on('SIGTERM', terminate);
process.on('SIGINT', interrupt);
const bounded = async (promise, timeoutMs = 3000, duringCleanup = false) => {
  let timer, abort;
  try {
    if (!duringCleanup) stopping.signal.throwIfAborted();
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(stopping.signal.reason);
      if (!duringCleanup) stopping.signal.addEventListener('abort', abort, { once: true });
    });
    return await Promise.race([
      cancelled,
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
    if (abort) stopping.signal.removeEventListener('abort', abort);
  }
};
const marker = path.join(root, 'hook-started.json');
const cleaned = path.join(root, 'hook-cleaned');
const stopHook = path.join(root, 'stop-hook');
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
    `import {existsSync,writeFileSync} from 'node:fs';
let closing=false;
const close=()=>{if(closing)return;closing=true;setTimeout(()=>{writeFileSync(${JSON.stringify(cleaned)},'done');process.exit(0)},100)};
process.on('SIGTERM',close);
// The proof owns shutdown even before it has read the hook's PID.
setInterval(()=>{
  if(existsSync(${JSON.stringify(stopHook)}))close();
  try{process.kill(${process.pid},0)}catch(error){if(error.code!=='ESRCH')throw error;close()}
},20);
writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));
`,
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
          current_run_id: refreshHold ? null : owner.id,
          ...(refreshHold ? { cleanup_run_id: owner.id, cleanup_stop_unconfirmed: true } : {}),
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
  stopping.signal.throwIfAborted();
  for (const successor of refreshHold ? [] : [false, true]) {
    if (successor)
      await core.updateSlotStatus('release-proof', {
        lifecycle: 'held',
        phase: 'occupied',
        slot_epoch: 7,
        current_run_id: owner.id,
        cleanup_run_id: null,
      });
    await rm(marker, { force: true });
    await rm(cleaned, { force: true });
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
            const bytes = await readFile(marker, 'utf8');
            if (earlyInterruption) {
              assert.equal(hookIdentity, undefined);
              console.log(JSON.stringify({ phase: 'interrupt-before-identity', root }));
              process.kill(process.pid, 'SIGTERM');
              await pause();
              stopping.signal.throwIfAborted();
            }
            processRow = JSON.parse(bytes);
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
    if (expectedInterruption) {
      console.log(JSON.stringify({ phase: 'interrupt-ready', root, hookIdentity }));
      process.kill(process.pid, 'SIGTERM');
      await pause();
      stopping.signal.throwIfAborted();
    }
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
    assert.equal(
      await readFile(cleaned, 'utf8'),
      'done',
      'hook asynchronous closeout must finish before replay becomes possible',
    );
    assert.equal(alive(hookIdentity.pid), false);
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
  if (refreshHold) {
    // The unresolved stop is an input fixture, seeded before the server starts.
    // Exercise the real row rebuild through RPC, then its owning retry path.
    await client.call('fleet.refresh', {});
    const refreshed = await core.readSlotRow('release-proof');
    assert.equal(refreshed.cleanup_stop_unconfirmed, true);
    assert.equal(refreshed.cleanup_run_id, owner.id);
    assert.equal(refreshed.current_run_id, null);
    assert.equal(refreshed.lifecycle, 'held');
    assert.equal(refreshed.phase, 'occupied');
    const { retryOccupiedRunSlot } = await load(
      'services/gateway/src/run-lifecycle/slot-teardown.ts',
    );
    assert.equal(await retryOccupiedRunSlot('release-proof'), false);
    assert.deepEqual(await core.readSlotRow('release-proof'), refreshed);
    receipts.push({
      method: 'fleet.refresh',
      status: 'PASS',
      observed: refreshed,
      retryRefused: true,
    });
  }
  console.log(
    JSON.stringify({
      status: 'PASS',
      receipts,
      scope: refreshHold
        ? 'Authenticated fleet.refresh and actual retry over a pre-start unconfirmed-stop fixture. No remote-stop or native claim.'
        : 'Authenticated RPC, real hanging project hook and durable writes; only the deadline clock is controlled. No model or native action.',
    }),
  );
} catch (error) {
  primaryError = error;
} finally {
  mock.timers.reset();
  await cleanup(async () => {
    // An issued request may start its hook after the marker wait was cancelled.
    await writeFile(stopHook, '', { flag: 'wx', mode: 0o600 });
    if (hookIdentity && alive(hookIdentity.pid)) {
      assert.equal(
        execFileSync('ps', ['-p', String(hookIdentity.pid), '-o', 'lstart='], {
          encoding: 'utf8',
        }).trim(),
        hookIdentity.birth,
      );
      process.kill(hookIdentity.pid, 'SIGTERM');
    }
    if (requestOutcome) await bounded(requestOutcome, 3000, true);
    if (hookIdentity)
      await bounded(
        (async () => {
          while (alive(hookIdentity.pid)) await pause();
        })(),
        3000,
        true,
      );
    if (earlyInterruption && primaryError === stopping.signal.reason) {
      assert.equal(hookIdentity, undefined, 'the interruption precedes PID capture');
      const observed = JSON.parse(await readFile(marker, 'utf8'));
      assert.equal(await readFile(cleaned, 'utf8'), 'done');
      assert.equal(alive(observed.pid), false, 'the uncaptured hook must have stopped');
    }
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
  process.off('SIGTERM', terminate);
  process.off('SIGINT', interrupt);
}

if (cleanupErrors.length)
  throw new AggregateError(
    [primaryError, ...cleanupErrors].filter(Boolean),
    `Release proof cleanup failed; retained ${root}`,
  );
if (expectedInterruption && primaryError === stopping.signal.reason && !cleanupErrors.length) {
  console.log(
    JSON.stringify({
      status: 'PASS',
      signal: primaryError.message,
      hookStopped: true,
      serverClosed: true,
    }),
  );
} else if (primaryError) throw primaryError;
