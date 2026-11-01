#!/usr/bin/env tsx
// Live proof (F296) that a pool rewrite landing during a dispatch's launch preflight no longer
// fails the run: the engine dispatches once more on the re-read inputs and the worker launches.
//
// An isolated gateway and node (their own pool, projects, runs, home and private tmux server)
// dispatch a scripted dev run through run.create. The pool's machine PATH puts a fixture `node`
// first: when the launch preflight's code probe runs, it rewrites one machine env value in the pool
// file once, as the 0.94.9 pin update did to Extension a1b1684a and Terminal b075cfb6. The run must
// record the retry, launch its worker, and reach MONITOR. Nothing else is substituted.
//
// Run: yarn tsx scripts/runner-validation/gateway/launch-inputs-reload.mts [evidence-dir]
import { testGatewayIdentity } from '../../lib/test-gateway-identity-source.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, openSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  GatewayClient,
  GatewayConnectionError,
  type GatewayConnection,
} from '../../../packages/cli/src/gateway-client.js';
import type { Run } from '../../../packages/protocol/src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(root, process.argv[2] ?? `temp/launch-inputs-reload/${Date.now()}`);
await mkdir(evidence, { recursive: true });
// The node resolves the checkout's real path (macOS /var is /private/var); the pool names it.
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'launch-inputs-reload-')));
// Every tmux call here, the gateway's and the node's reach only this proof's private server.
const tmuxDir = await mkdtemp('/tmp/lir-');
const machine = 'launch-reload-node';
const slotId = 'launch-reload-slot';
const session = path.basename(fixture);
const repo = path.join(fixture, 'repo');
const poolFile = path.join(fixture, 'pool/launch-reload.json');
const rewrote = path.join(fixture, 'pool-rewritten');
const baseEnv: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: tmuxDir };
delete baseEnv.TMUX;
delete baseEnv.TMUX_PANE;

async function json(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}
const tmux = (...args: string[]) =>
  execFileSync('tmux', args, { encoding: 'utf8', env: baseEnv }).trim();

async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function startWorkspaceProcess(workspace: string, log: string, env: NodeJS.ProcessEnv) {
  const fd = openSync(path.join(evidence, log), 'w', 0o600);
  const child = spawn('yarn', ['workspace', workspace, 'start'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...baseEnv, ...env },
  });
  closeSync(fd);
  return child;
}

async function stopProcess(child: ChildProcess | undefined) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, 'exit');
  process.kill(-child.pid, 'SIGTERM');
  if (!(await Promise.race([stopped.then(() => true), delay(5000).then(() => false)]))) {
    process.kill(-child.pid, 'SIGKILL');
    await stopped;
  }
}

async function poll<T>(description: string, read: () => Promise<T | undefined>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(500);
  }
}

execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe' });
execFileSync('git', ['clone', '--shared', '--no-checkout', root, repo], { stdio: 'pipe' });
for (const dir of [fixture, repo])
  for (const entry of ['scripts', 'services', 'packages', 'node_modules', 'package.json'])
    await symlink(path.join(root, entry), path.join(dir, entry));
// The launch preflight checks the slot's package manager the way a worker would run it.
for (const entry of ['.yarnrc.yml', '.yarn', 'yarn.lock', '.nvmrc'])
  if (existsSync(path.join(root, entry)))
    await symlink(path.join(root, entry), path.join(repo, entry));
await symlink(path.join(fixture, 'projects'), path.join(repo, 'projects'));
await writeFile(path.join(fixture, 'CLAUDE.md'), '# Isolated launch-inputs reload fixture\n');
await writeFile(path.join(repo, 'CLAUDE.md'), '# Isolated launch-inputs reload checkout\n');
const project = path.join(fixture, 'projects/launch-reload');
await mkdir(path.join(project, 'templates/prompts'), { recursive: true });
await writeFile(
  path.join(project, 'templates/prompts/worker-dispatch.md'),
  'Read {{TASK_FILE}} and run the configured command.\n',
);
await mkdir(path.join(project, 'templates/worker'), { recursive: true });
await writeFile(
  path.join(project, 'templates/worker/dev.md'),
  '# Worker: dev\n\n- [ ] Run the configured command.\n',
);
await json(path.join(project, 'project.json'), {
  name: 'launch-reload',
  repo_url: root,
  paths: { runtime_dir: '.agent', artifact_dir: '.task' },
  execution_templates: { sources: [] },
  // Keeps the worker alive until the run is read at MONITOR; the run is cancelled afterwards.
  scripted: { commands: { hold: { command: 'sleep 300', timeout_ms: 330_000 } } },
  monitoring: { poll_interval_min: 0.02, total_timeout_min: 10 },
});
// The fixture `node` the slot's shell finds first. The launch preflight's code probe is the only
// call carrying its program text; the first one rewrites the pool file, then every call is node.
const shimDir = path.join(fixture, 'shim');
await mkdir(shimDir);
await writeFile(
  path.join(shimDir, 'node'),
  [
    '#!/bin/sh',
    'case "$*" in',
    '  *"Worker farmslot CLI is missing"*)',
    `    if mkdir ${JSON.stringify(rewrote)} 2>/dev/null; then`,
    `      ${JSON.stringify(process.execPath)} -e 'const fs=require("fs"),f=process.argv[1],p=JSON.parse(fs.readFileSync(f,"utf8"));p.env.LAUNCH_RELOAD_PIN="after";fs.writeFileSync(f,JSON.stringify(p,null,2))' ${JSON.stringify(poolFile)}`,
    '    fi;;',
    'esac',
    `exec ${JSON.stringify(process.execPath)} "$@"`,
    '',
  ].join('\n'),
);
await chmod(path.join(shimDir, 'node'), 0o755);
await json(poolFile, {
  machine,
  host: 'localhost',
  ssh_user: process.env.USER ?? 'operator',
  project: 'launch-reload',
  platform: 'cli',
  os: process.platform,
  env: { PATH: `${shimDir}:${process.env.PATH}`, LAUNCH_RELOAD_PIN: 'before' },
  slots: [{ id: slotId, enabled: true, repo, session, resources: {} }],
});
await json(path.join(fixture, '.farm-status.json'), {
  checked_at: new Date().toISOString(),
  slots: [
    {
      slot: slotId,
      machine,
      project: 'launch-reload',
      platform: 'cli',
      repo,
      session,
      lifecycle: 'ready',
      phase: null,
      agent: 'idle',
      enabled: true,
      health: { ssh: 'LOCAL', device: '-', devserver: 'OK', fixtures: '-' },
    },
  ],
});

const port = await freePort();
const token = testGatewayIdentity(path.join(fixture, 'home'), `ws://127.0.0.1:${port}`);
const gateway = startWorkspaceProcess('@farmslot/gateway', 'gateway.log', {
  FARMSLOT_ROOT: fixture,
  FARMSLOT_HOME: path.join(fixture, 'home'),
  FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
  FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
  FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
  FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
  GATEWAY_HOST: '127.0.0.1',
  GATEWAY_PORT: String(port),
  FARMSLOT_GATEWAY_PROFILE: 'proof',
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
});
let node: ChildProcess | undefined;
let connection: GatewayConnection | undefined;
let run: Run | undefined;
let failure: unknown;
let result: Record<string, unknown> | undefined;
try {
  tmux('new-session', '-d', '-s', session, '-c', repo);
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    timeout: 30_000,
    credential: { token },
  });
  connection = await poll(
    'the isolated gateway',
    async () => {
      if (gateway.exitCode !== null) throw new Error('Isolated gateway exited before readiness');
      try {
        return await client.connect();
      } catch (error) {
        // Connection refusal is expected while the gateway starts on its isolated port.
        if (!(error instanceof GatewayConnectionError)) throw error;
        return undefined;
      }
    },
    60_000,
  );
  const gw = connection;
  const { principal } = await gw.call<{ principal: { id: string } }>('principal.create', {
    subject: { type: 'node', machine, displayName: 'Launch reload fixture node' },
    roles: [],
  });
  const credential = await gw.call<{ secret: string }>('credential.issue', {
    principalId: principal.id,
    displayName: 'Launch reload fixture node',
  });
  const nodeRoot = path.join(fixture, 'node');
  await mkdir(nodeRoot, { recursive: true });
  node = startWorkspaceProcess('@farmslot/node', 'node.log', {
    FARMSLOT_ROOT: nodeRoot,
    FARMSLOT_HOME: path.join(nodeRoot, 'home'),
    FARMSLOT_NODE_TOKEN: credential.secret,
    GATEWAY_URL: `ws://127.0.0.1:${port}`,
    MACHINE_NAME: machine,
    SCREEN_CONTROL_SOCKET: path.join(fixture, 'screen.sock'),
  });

  run = (
    await gw.call<{ run: Run }>('run.create', {
      project: 'launch-reload',
      flowType: 'dev',
      mode: 'interactive',
      ticketOrPr: 'launch inputs reload proof',
      initialContext: 'Launch inputs reload validation run. Makes no changes.',
      slotId,
      runner: 'scripted',
      model: 'scripted',
      scripted: { mode: 'command', commandRef: 'hold' },
      skipPrepare: true,
      completionPolicy: 'artifact-only',
    })
  ).run;
  const runId = run.id;
  const monitoring = await poll(
    'the run to reach MONITOR',
    async () => {
      run = (await gw.call<{ run: Run }>('run.get', { runId })).run;
      const dispatch = run.steps.find((step) => step.name === 'dispatch');
      if (
        ['done', 'failed', 'blocked', 'cancelled'].includes(run.status) ||
        dispatch?.status === 'failed'
      )
        throw new Error(
          `Dispatch did not survive the reload (${run.status}): ${run.error ?? dispatch?.detail}`,
        );
      return run.steps.find((step) => step.name === 'monitor')?.status === 'running'
        ? run
        : undefined;
    },
    180_000,
  );
  await json(path.join(evidence, 'run.json'), monitoring);
  const dispatch = monitoring.steps.find((step) => step.name === 'dispatch')!;
  const subSteps = (
    (dispatch.outputs?.subSteps ?? []) as Array<{ name: string; detail?: string }>
  ).map((step) => step.name);
  assert.ok(existsSync(rewrote), 'the pool file was rewritten during the code probe');
  assert.equal(
    JSON.parse(await readFile(poolFile, 'utf8')).env.LAUNCH_RELOAD_PIN,
    'after',
    'the rewrite stuck',
  );
  assert.equal(dispatch.status, 'done');
  assert.ok(subSteps.includes('preflight-retry'), `the retry is recorded: ${subSteps.join(', ')}`);
  result = { pass: true, evidence, runId, dispatchSubSteps: subSteps };
  await json(path.join(evidence, 'result.json'), result);
} catch (error) {
  failure = error;
  await json(path.join(evidence, 'failure.json'), { error: String(error), fixture });
} finally {
  const cleanupErrors: unknown[] = [];
  if (connection && run && !['done', 'failed', 'cancelled'].includes(run.status)) {
    await connection
      .call('run.cancel', { runId: run.id, reason: 'launch inputs reload fixture cleanup' })
      .catch((error: unknown) => cleanupErrors.push(error));
  }
  connection?.close();
  await stopProcess(node);
  await stopProcess(gateway);
  // The proof's own tmux server under its private TMUX_TMPDIR; no other server is touched.
  spawnSync('tmux', ['kill-server'], { stdio: 'ignore', env: baseEnv });
  await rm(fixture, { recursive: true, force: true });
  await rm(tmuxDir, { recursive: true, force: true });
  if (cleanupErrors.length > 0)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      'Cleanup failed',
    );
}
if (failure) throw failure;
console.log(JSON.stringify(result));
