// Manual proof only. Input describes a prepared, private farm on the target host.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('../../../', import.meta.url));
const inputBytes = await readFile(process.argv[2]);
const input = JSON.parse(inputBytes);
const root = await realpath(input.root);
const out = path.resolve(input.output);
const owner = JSON.parse(await readFile(path.join(root, 'proof-owned.json'), 'utf8'));
assert.equal(owner.id, input.id);
assert.equal(owner.purpose, 'terminal-prepare-smoke');
assert.equal(os.hostname().split('.')[0], input.machine);
assert.equal((await lstat(root)).mode & 0o077, 0);
assert.notEqual(root, source);
assert((await realpath(input.cli)).startsWith(root + path.sep));
assert((await realpath(input.repo)).startsWith(root + path.sep));
assert(out.startsWith(root + path.sep));
assert.match(input.slotId, /^[a-z0-9][a-z0-9_-]*$/);
assert.match(input.session, /^[a-z0-9][a-z0-9_-]*$/);
await mkdir(out, { recursive: true, mode: 0o700 });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) =>
  writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
const identity = async (file) => {
  try {
    const row = await lstat(file);
    return { exists: true, dev: row.dev, ino: row.ino };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false };
    throw error;
  }
};
const defaults = {
  tmux: `/tmp/tmux-${process.getuid()}/default`,
  screen: `/tmp/farmslot-screen-control-${process.getuid()}.sock`,
};
const before = Object.fromEntries(
  await Promise.all(
    Object.entries(defaults).map(async ([name, file]) => [name, await identity(file)]),
  ),
);
for (const name of Object.keys(process.env)) {
  if (
    name.startsWith('FARMSLOT_') ||
    ['TMUX', 'TMUX_PANE', 'NODE_OPTIONS', 'GW_URL', 'GATEWAY_URL', 'GATEWAY_TOKEN'].includes(name)
  )
    delete process.env[name];
}
const socket = path.join(root, 'tm', `tmux-${process.getuid()}`, 'default');
const selected = {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '0',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
  FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
  FARMSLOT_ANALYTICS_DIR: path.join(root, 'analytics'),
  FARMSLOT_CAPABILITY_STORE_FILE: path.join(root, 'capabilities.json'),
  FARMSLOT_CLI: input.cli,
  TMUX_TMPDIR: path.join(root, 'tm'),
  FARMSLOT_TMUX_SANDBOX: socket,
  SCREEN_CONTROL_SOCKET: path.join(root, 'screen.sock'),
  TMPDIR: path.join(root, 'tmp'),
};
Object.assign(process.env, selected);
await mkdir(selected.TMPDIR, { recursive: true, mode: 0o700 });
await mkdir(path.dirname(socket), { recursive: true, mode: 0o700 });
const bin = path.join(root, 'proof-bin');
const tmux = (
  await exec('which', ['tmux'], {
    env: {
      ...process.env,
      PATH: process.env.PATH.split(path.delimiter)
        .filter((entry) => entry !== bin)
        .join(path.delimiter),
    },
  })
).stdout.trim();
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
await mkdir(bin, { recursive: true, mode: 0o700 });
const wrapper = path.join(bin, 'tmux');
const wrapperBytes = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = -S ]; then
  [ "\${2:-}" = ${quote(socket)} ] || { echo 'Foreign tmux socket refused' >&2; exit 1; }
  shift 2
fi
exec ${quote(tmux)} -S ${quote(socket)} "$@"
`;
if ((await identity(wrapper)).exists) assert.equal(await readFile(wrapper, 'utf8'), wrapperBytes);
else await writeFile(wrapper, wrapperBytes, { flag: 'wx', mode: 0o700 });
process.env.PATH = bin + path.delimiter + process.env.PATH;
const load = (relative) => import(pathToFileURL(path.join(source, relative)).href);
const { statusFile } = await load('services/gateway/src/core/state.ts');
const { runsDirectory } = await load('services/gateway/src/runs/store.ts');
assert.equal(statusFile, selected.FARMSLOT_TEST_STATUS_FILE);
assert.equal(runsDirectory(), selected.FARMSLOT_RUNS_DIR);
const { loadSlotVars, loadProjectVars } = await load('services/gateway/src/core/config.ts');
const vars = await loadSlotVars(input.slotId);
assert.equal(vars.host, 'localhost');
assert.equal(typeof vars.sshUser, 'string');
assert.equal(await realpath(vars.remoteRepo), await realpath(input.repo));
assert.equal(vars.session, input.session);
assert.equal(vars.projectName, input.project);
const projectVars = await loadProjectVars(input.project);
const { projectJson } = projectVars;
assert.equal(projectJson.prepare?.default, 'full');
assert.deepEqual(projectJson.prepare.profiles.full.phases, [
  'git',
  'fixtures',
  'deps',
  'preflight',
  'health',
]);
const { runnerSupportsModel } = await load('services/gateway/src/runners/registry.ts');
assert.equal(runnerSupportsModel(input.runner, input.model), true);
const { createWebSocketServer, broadcastEvent } = await load('services/gateway/src/server.ts');
const { createGatewayAuthRuntime } = await load('services/gateway/src/security/auth.ts');
const { GatewayClient } = await load('packages/cli/src/gateway-client.ts');
const { initRunEngine } = await load('services/gateway/src/run-engine/orchestrator.ts');
for (const [name, file] of Object.entries(defaults))
  assert.deepEqual(await identity(file), before[name]);
const fingerprint = {
  inputHash: digest(inputBytes),
  driverHash: digest(await readFile(fileURLToPath(import.meta.url))),
};
if (process.argv[3] === '--preflight') {
  await assert.rejects(
    exec(wrapper, ['-S', defaults.tmux, 'display-message', '-p', '#{pid}']),
    (error) => error.code === 1 && error.stderr.includes('Foreign tmux socket refused'),
  );
  await exec(input.cli, ['--help'], { timeout: 30_000 });
  await exec(input.cli, ['internal', 'slot-vars', input.slotId, '--shell'], { timeout: 30_000 });
  const { checkProjectPrerequisites } = await load(
    'services/gateway/src/methods/slot/prerequisites.ts',
  );
  const requirements = await checkProjectPrerequisites(vars, projectJson, projectVars);
  assert.equal(requirements?.status, 'pass', requirements?.detail);
  await save('preflight.json', {
    status: 'PASS',
    ...fingerprint,
    selected,
    before,
    source,
    scope: 'Imports, CLI help and foreign-socket refusal only. No gateway, app or run started.',
  });
  process.exit(0);
}
const preflight = JSON.parse(await readFile(path.join(out, 'preflight.json'), 'utf8'));
assert.equal(preflight.status, 'PASS');
assert.equal(preflight.inputHash, fingerprint.inputHash);
assert.equal(preflight.driverHash, fingerprint.driverHash);
await save('invocation.json', { ...fingerprint, source, selected, at: new Date().toISOString() });

let server, wss, connection, runId, primaryError, socketIdentity, serverPid, serverBirth;
const cleanup = [];
const attempt = async (label, operation) => {
  try {
    await operation();
    cleanup.push({ label, status: 'PASS' });
  } catch (error) {
    cleanup.push({ label, status: 'FAIL', error: error.message });
  }
};
const brief = (run) => ({
  id: run.id,
  project: run.project,
  slotId: run.slotId,
  status: run.status,
  runner: run.runner,
  model: run.model,
  transport: run.transport,
  steps: run.steps.map(({ name, status, startedAt, completedAt, durationMs }) => ({
    name,
    status,
    startedAt,
    completedAt,
    durationMs,
  })),
});
try {
  await exec(wrapper, ['new-session', '-d', '-s', input.session, '-c', input.repo]);
  socketIdentity = await identity(socket);
  serverPid = (await exec(wrapper, ['display-message', '-p', '#{pid}'])).stdout.trim();
  serverBirth = (await exec('ps', ['-p', serverPid, '-o', 'lstart='])).stdout.trim();
  server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  Object.assign(process.env, { GW_URL: url, GATEWAY_URL: url, FARMSLOT_GATEWAY: url });
  const { testGatewayIdentity } = await load('scripts/lib/test-gateway-identity-source.mts');
  const token = testGatewayIdentity(selected.FARMSLOT_HOME, url);
  wss = createWebSocketServer(
    server,
    createGatewayAuthRuntime({ FARMSLOT_HOME: selected.FARMSLOT_HOME }),
  );
  initRunEngine(broadcastEvent, broadcastEvent);
  connection = await new GatewayClient({ url, timeout: 600_000, credential: { token } }).connect();
  const created = await connection.call('run.create', {
    project: input.project,
    slotId: input.slotId,
    branch: input.branch,
    flowType: 'dev',
    mode: 'validation',
    transport: 'tmux',
    runner: input.runner,
    model: input.model,
    executionTemplateId: 'dev/default',
    ticketOrPr: 'F203-1',
    ticketData: {
      source: 'manual',
      title: 'Terminal prepare validation',
      description:
        'Acknowledge this dispatch, then wait. Do not edit files, install, run commands, launch applications or place trades.',
      affectedArea: 'prepare',
      acceptanceCriteria: ['Acknowledge and wait without changing files'],
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
    initialContext: 'Proof worker only. Reply ACK and wait; no tool calls or product changes.',
  });
  runId = created.run.id;
  await save('created.json', brief(created.run));
  console.log(JSON.stringify({ phase: 'created', runId }));
  const deadline = Date.now() + (input.timeoutMs ?? 900_000);
  let run = created.run;
  let lastPhase;
  for (;;) {
    run = (await connection.call('run.get', { runId, view: 'snapshot' })).run;
    const phase = run.steps.find((step) => step.status === 'running')?.name ?? run.status;
    if (phase !== lastPhase) {
      console.log(JSON.stringify({ phase, runId }));
      lastPhase = phase;
    }
    if (['failed', 'blocked', 'cancelled', 'done'].includes(run.status)) {
      await save('first-failure.json', { ...brief(run), error: run.error });
      throw new Error(`Proof run ${runId} stopped at ${phase}: ${run.error ?? run.status}`);
    }
    if (run.steps.find((step) => step.name === 'dispatch')?.status === 'done') break;
    assert(
      Date.now() < deadline,
      `Proof timed out on ${phase}; preserve ${runId} for in-place diagnosis`,
    );
    await delay(500);
  }
  for (const name of ['write-task', 'prepare', 'dispatch'])
    assert.equal(run.steps.find((step) => step.name === name)?.status, 'done', name);
  assert.equal(run.runner, input.runner);
  assert.equal(run.model, input.model);
  await save('dispatched.json', brief(run));
  console.log(JSON.stringify({ phase: 'dispatched', runId }));
} catch (error) {
  primaryError = error;
} finally {
  if (connection && runId)
    await attempt('cancel only the owned run', async () => {
      const run = (await connection.call('run.get', { runId, view: 'snapshot' })).run;
      if (!['failed', 'done', 'cancelled'].includes(run.status))
        await connection.call('run.cancel', { runId, reason: 'Terminal prepare smoke finished' });
      await save(
        'final-run.json',
        brief((await connection.call('run.get', { runId, view: 'snapshot' })).run),
      );
    });
  if (runId)
    await attempt('await the owned teardown registry release', async () => {
      const { isTerminalTeardownInFlight } = await load(
        'services/gateway/src/run-engine/terminal-teardown-registry.ts',
      );
      const deadline = Date.now() + 310_000;
      while (isTerminalTeardownInFlight(input.slotId)) {
        assert(Date.now() < deadline, 'owned teardown did not release its registry entry');
        await delay(50);
      }
      await save('teardown-registry.json', {
        status: 'PASS',
        slotId: input.slotId,
        inFlight: false,
      });
    });
  await attempt('stop only this slot runtime', async () => {
    const core = await load('services/gateway/src/core/index.ts');
    const vars = await core.loadSlotVars(input.slotId);
    assert.equal(await realpath(vars.remoteRepo), await realpath(input.repo));
    const { projectJson, ...project } = await core.loadProjectVars(input.project);
    const command = core.expandHook('teardown', projectJson, vars, { ...project, projectJson });
    assert(command, 'the real Terminal teardown hook is required');
    const result = await core.execOnSlot(
      vars,
      core.withProjectMachineEnv(command, vars, projectJson, { ...project, projectJson }),
      { timeout: 60_000 },
    );
    assert.equal(result.exitCode, 0, 'owned Terminal teardown failed');
  });
  if (connection) await attempt('close client', async () => connection.close());
  if (wss)
    await attempt('close owned WebSocket server', async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
    });
  if (server?.listening)
    await attempt(
      'close owned HTTP server',
      () =>
        new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
  if (socketIdentity)
    await attempt('stop owned tmux server by inode and birth', async () => {
      if (!(await identity(socket)).exists) return;
      assert.deepEqual(await identity(socket), socketIdentity);
      assert.equal(
        (await exec('ps', ['-p', serverPid, '-o', 'lstart='])).stdout.trim(),
        serverBirth,
      );
      await exec(wrapper, ['kill-server']);
    });
  await attempt('preserve default socket identities', async () => {
    for (const [name, file] of Object.entries(defaults))
      assert.deepEqual(await identity(file), before[name]);
  });
  await save('cleanup.json', {
    status: cleanup.every((row) => row.status === 'PASS') ? 'PASS' : 'FAIL',
    cleanup,
  });
}
if (primaryError) throw primaryError;
assert(
  cleanup.every((row) => row.status === 'PASS'),
  'scoped cleanup failed',
);
await save('result.json', {
  status: 'PASS',
  ...fingerprint,
  runId,
  runner: input.runner,
  model: input.model,
  scope:
    'One real Terminal pipeline through dispatch; no product change, publication or original-run action.',
});
console.log(JSON.stringify({ phase: 'finished', status: 'PASS', runId }));
