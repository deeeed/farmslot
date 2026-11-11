// Disposable gateway with real delayed shutdown hooks and flag-backed resources.
// Completion must accept verified late stops and keep live resources held.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { testGatewayIdentity } from '../../lib/test-gateway-identity.mjs';
import {
  closeTmuxSandbox,
  GIT_LOCATION_ENV,
  openTmuxSandbox,
  tmuxSandboxEnvironment,
} from '../../quality/run-tsx-tests.mjs';

const sourceRoot = process.cwd();
const temporaryRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'farmslot-late-shutdown-')));
const root = path.join(temporaryRoot, 'root');
const project = `late-shutdown-${randomUUID()}`;
const tmuxDir = openTmuxSandbox();
const baseEnv = { ...process.env };
for (const key of GIT_LOCATION_ENV) delete baseEnv[key];
let gateway;
let logFd;

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function git(cwd, ...args) {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, env: baseEnv, stdio: 'pipe' },
  );
}
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

try {
  mkdirSync(root, { recursive: true });
  cpSync(path.join(sourceRoot, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  symlinkSync(path.join(sourceRoot, 'packages'), path.join(root, 'packages'), 'dir');
  symlinkSync(path.join(sourceRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable late shutdown fixture\n');
  mkdirSync(path.join(temporaryRoot, 'home/run-archive'), { recursive: true });
  git(root, 'init', '-q');
  git(root, 'commit', '--allow-empty', '-qm', 'fixture root');
  writeJson(path.join(root, 'services/gateway/package.json'), {
    name: 'fixture',
    version: '0.0.0',
  });
  const origin = path.join(temporaryRoot, 'origin.git');
  git(temporaryRoot, 'init', '-q', '--bare', '--initial-branch=main', origin);
  const seed = path.join(temporaryRoot, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '--initial-branch=main');
  writeFileSync(path.join(seed, 'README.md'), 'Fixture\n');
  writeJson(path.join(seed, 'package.json'), {
    name: 'late-shutdown-fixture',
    private: true,
    type: 'module',
    engines: { node: '>=22.12.0' },
  });
  for (const name of ['packages', 'node_modules'])
    symlinkSync(path.join(sourceRoot, name), path.join(seed, name));
  symlinkSync(path.join(root, 'projects'), path.join(seed, 'projects'));
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'fixture');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-qu', 'origin', 'main');
  const hook = path.join(temporaryRoot, 'shutdown.cjs');
  writeFileSync(
    hook,
    "const fs = require('fs'); if (!fs.existsSync(process.argv[2])) process.exit(0); setTimeout(() => { if (process.argv[3] === 'stop') fs.unlinkSync(process.argv[2]); }, Number(process.argv[4]));\n",
  );
  const fixtures = ['stop', 'keep'].map((action) => {
    const slotId = `late-${action}-${randomUUID()}`;
    const runId = randomUUID();
    const repo = path.join(temporaryRoot, slotId);
    git(temporaryRoot, 'clone', '-q', origin, repo);
    const flag = path.join(temporaryRoot, `${action}.running`);
    writeFileSync(flag, '');
    const now = new Date().toISOString();
    writeJson(path.join(root, '.runs', `${runId}.json`), {
      id: runId,
      project,
      ticketOrPr: 'late shutdown fixture',
      flowType: 'dev',
      mode: 'interactive',
      transport: 'tmux',
      status: 'failed',
      slotId,
      taskFile: null,
      createdAt: now,
      updatedAt: now,
      decisions: [],
      metrics: { nudgeCount: 0, runner: 'scripted', model: null },
      steps: [],
    });
    return { action, slotId, runId, flag, repo };
  });
  const mixed = {
    slotId: `mixed-${randomUUID()}`,
    repo: path.join(temporaryRoot, 'mixed'),
    stopped: path.join(temporaryRoot, 'mixed-stop.running'),
    pending: path.join(temporaryRoot, 'mixed-pending.running'),
  };
  git(temporaryRoot, 'clone', '-q', origin, mixed.repo);
  writeFileSync(mixed.stopped, '');
  writeFileSync(mixed.pending, '');
  writeJson(path.join(root, 'pool/late.json'), {
    machine: os.hostname(),
    host: 'localhost',
    ssh_user: os.userInfo().username,
    os: process.platform,
    slots: [
      ...fixtures.map(({ action, slotId, repo, flag }) => ({
        id: slotId,
        project,
        platform: 'cli',
        repo,
        session: slotId,
        enabled: true,
        mode: 'dispatch',
        resources: { 'dev-server': { flag, action, delay_ms: 16000 } },
      })),
      {
        id: mixed.slotId,
        project,
        platform: 'cli',
        repo: mixed.repo,
        session: mixed.slotId,
        enabled: true,
        mode: 'dispatch',
        resources: {
          'dev-server': { flag: mixed.stopped, action: 'stop', delay_ms: 16000 },
          'pending-service': {
            pending_flag: mixed.pending,
            pending_action: 'keep',
            pending_delay_ms: 35000,
          },
        },
      },
    ],
  });
  const resource = (prefix, type) => ({
    type,
    label: 'Fixture service',
    controllable: true,
    hooks: {
      health: `test -f "{{${prefix}flag}}"`,
      shutdown: `"${process.execPath}" "${hook}" "{{${prefix}flag}}" "{{${prefix}action}}" "{{${prefix}delay_ms}}"`,
    },
  });
  writeJson(path.join(root, 'projects', project, 'project.json'), {
    name: project,
    type: 'monorepo',
    default_branch: 'main',
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
    default_safety_tier: 'dangerous',
    execution_templates: { sources: [] },
    prepare: {
      default: 'proof',
      profiles: { proof: { phases: ['preflight'], hooks: { preflight: 'true' } } },
    },
    scripted: {
      commands: { smoke: { command: 'node -e "setInterval(() => {}, 1000)"', timeout_ms: 120000 } },
    },
    // Shutdown reverses this order: the confirmed service precedes the pending one.
    resources: {
      'pending-service': resource('pending_', 'service'),
      'dev-server': resource('', 'dev-server'),
    },
  });
  const template = path.join(root, 'projects', project, 'templates/worker/dev.md');
  mkdirSync(path.dirname(template), { recursive: true });
  writeFileSync(template, '# Worker: dev\n\n- [ ] Disposable dispatch smoke.\n');
  const prompt = path.join(root, 'projects', project, 'templates/prompts/worker-dispatch.md');
  mkdirSync(path.dirname(prompt), { recursive: true });
  writeFileSync(prompt, 'Read {{TASK_FILE}} and execute the declared smoke command.\n');
  const statusFile = path.join(temporaryRoot, 'fixture-status.json');
  writeJson(statusFile, {
    checked_at: new Date().toISOString(),
    slots: fixtures.map(({ slotId, runId }) => ({
      slot: slotId,
      lifecycle: 'busy',
      phase: 'working',
      agent: 'idle',
      current_run_id: runId,
      slot_epoch: 1,
    })),
  });
  const port = await freePort();
  testGatewayIdentity(path.join(temporaryRoot, 'home'), `ws://127.0.0.1:${port}`);
  const env = tmuxSandboxEnvironment(
    {
      ...baseEnv,
      FARMSLOT_ROOT: root,
      FARMSLOT_HOME: path.join(temporaryRoot, 'home'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
      FARMSLOT_CAPABILITY_STORE_FILE: path.join(root, '.runs/runtime-capabilities.json'),
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DISABLE_RUN_ENGINE_START: '0',
      NODE_TEST_CONTEXT: '1',
      FARMSLOT_TEST_STATUS_FILE: statusFile,
      FARMSLOT_DEMO_POOL: '0',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      FARMSLOT_GATEWAY_PROFILE: 'proof',
      FARMSLOT_GATEWAY_PASSWORD: '',
      FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
      FARMSLOT_RPC_TIMEOUT_MS: '60000',
      TSX_TSCONFIG_PATH: path.join(sourceRoot, 'services/gateway/tsconfig.json'),
    },
    tmuxDir,
  );
  const rpc = (method, params) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
        { cwd: sourceRoot, env, encoding: 'utf8', timeout: 90000, stdio: 'pipe' },
      ),
    );
  logFd = openSync(path.join(temporaryRoot, 'gateway.log'), 'w');
  gateway = spawn(process.execPath, ['--import', 'tsx', 'services/gateway/src/index.ts'], {
    cwd: sourceRoot,
    env,
    stdio: ['ignore', logFd, logFd],
  });
  for (let attempt = 0; ; attempt++) {
    if (gateway.exitCode !== null || gateway.signalCode !== null)
      throw new Error('Fixture gateway exited');
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    if (attempt >= 450) throw new Error('Fixture gateway did not start');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const results = [];
  for (const fixture of fixtures) {
    const started = Date.now();
    const { run, effects } = rpc('run.forceComplete', { runId: fixture.runId });
    assert.equal(run.status, 'done');
    const row = JSON.parse(readFileSync(statusFile, 'utf8')).slots.find(
      (slot) => slot.slot === fixture.slotId,
    );
    assert.equal(existsSync(fixture.flag), fixture.action === 'keep');
    if (fixture.action === 'stop') {
      assert.equal(
        row.lifecycle,
        'ready',
        JSON.stringify({ row, effects, skipped: run.slotTeardownSkipped }),
      );
      assert.ok(!row.current_run_id && !row.cleanup_run_id && !row.cleanup_stop_unconfirmed);
    } else {
      assert.equal(row.lifecycle, 'held');
      assert.equal(row.cleanup_run_id, fixture.runId);
      assert.equal(row.cleanup_stop_unconfirmed, true);
    }
    results.push({
      runId: fixture.runId,
      action: fixture.action,
      elapsedMs: Date.now() - started,
      lifecycle: row.lifecycle,
      reason: run.slotTeardownSkipped,
    });
  }
  writeFileSync(fixtures[0].flag, '');
  const cleanup = rpc('slot.cleanup', { slotId: fixtures[0].slotId, reason: 'manual' });
  assert.deepEqual(cleanup.cleaned, ['dev-server']);
  assert.deepEqual(cleanup.skipped, []);
  assert.equal(existsSync(fixtures[0].flag), false);
  const mixedCleanup = rpc('slot.cleanup', { slotId: mixed.slotId, reason: 'manual' });
  assert.deepEqual(mixedCleanup.cleaned, ['dev-server']);
  assert.deepEqual(mixedCleanup.skipped, ['pending-service']);
  assert.match(mixedCleanup.skippedReason['pending-service'], /timeout|timed out/);
  assert.equal(existsSync(mixed.stopped), false);
  assert.equal(existsSync(mixed.pending), true);
  const smoke = rpc('run.create', {
    project,
    flowType: 'dev',
    mode: 'validation',
    ticketOrPr: 'FS-999999',
    ticketData: {
      source: 'manual',
      title: 'Dispatch smoke',
      description: 'Disposable gateway validation',
      acceptanceCriteria: [],
      affectedArea: '',
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
    slotId: fixtures[0].slotId,
    runner: 'scripted',
    prepareProfile: 'proof',
    scripted: { mode: 'command', commandRef: 'smoke' },
  }).run;
  let smokeRun;
  try {
    const deadline = Date.now() + 90000;
    do {
      smokeRun = rpc('run.get', { runId: smoke.id }).run;
      if (smokeRun.steps.find((step) => step.name === 'dispatch')?.status === 'done') break;
      assert.ok(!['failed', 'blocked'].includes(smokeRun.status), JSON.stringify(smokeRun));
      assert.ok(Date.now() < deadline, JSON.stringify(smokeRun));
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    for (const name of ['write-task', 'prepare', 'dispatch'])
      assert.equal(smokeRun.steps.find((step) => step.name === name)?.status, 'done', name);
  } finally {
    const current = rpc('run.get', { runId: smoke.id }).run;
    if (!['failed', 'done', 'cancelled'].includes(current.status))
      rpc('run.cancel', { runId: smoke.id, reason: 'Disposable dispatch smoke finished' });
  }
  const log = readFileSync(path.join(temporaryRoot, 'gateway.log'), 'utf8');
  assert.match(log, /error=timeout after 15000ms/);
  assert.match(log, /result=late-ok/);
  assert.match(log, /late-post-verify-still-running/);
  console.log(
    JSON.stringify(
      {
        sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: sourceRoot,
          env: baseEnv,
          encoding: 'utf8',
        }).trim(),
        sourceChanges: execFileSync('git', ['status', '--porcelain'], {
          cwd: sourceRoot,
          env: baseEnv,
          encoding: 'utf8',
        }).trim(),
        results,
        cleanup,
        mixedCleanup,
        smoke: {
          runId: smoke.id,
          steps: smokeRun.steps.map(({ name, status }) => ({ name, status })),
          cancelled: rpc('run.get', { runId: smoke.id }).run.status === 'cancelled',
        },
        shutdownLog: log.split('\n').filter((line) => line.includes('[teardown]')),
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (logFd !== undefined)
    console.error(readFileSync(path.join(temporaryRoot, 'gateway.log'), 'utf8').slice(-7000));
  throw error;
} finally {
  if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
    const stopped = once(gateway, 'exit');
    gateway.kill('SIGTERM');
    await stopped;
  }
  if (logFd !== undefined) closeSync(logFd);
  closeTmuxSandbox(tmuxSandboxEnvironment(baseEnv, tmuxDir));
  rmSync(temporaryRoot, { recursive: true, force: true });
}
