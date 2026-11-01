#!/usr/bin/env tsx
// Live proof (F298) that one slow workspace read no longer hides a slot's workspace until its node
// reconnects. An isolated gateway and node (own pool, projects, runs and home) observe a slot
// whose node-side `git` is a fixture: the first workspace probe leaves a process in its own
// session holding the probe's output open for 25 s, longer than the read's budget, cancel
// closeout and transport grace. The read fails as an unconfirmed closeout; when the node finally
// delivers that result on the same connection, the next fleet read must show the workspace.
// macpro-audiolab-1 stayed at "Execution … has unconfirmed closeout (timeout)" instead.
//
// Run: yarn tsx scripts/runner-validation/gateway/unconfirmed-read-release.mts [evidence-dir]
import { testGatewayIdentity } from '../../lib/test-gateway-identity-source.mjs';
import assert from 'node:assert/strict';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  cleanupOnExit,
  freePort,
  poll,
  startReaper,
  startWorkspaceProcess,
  stopProcess,
} from '../lib/isolated-stack.mjs';
import {
  GatewayClient,
  GatewayConnectionError,
  type GatewayConnection,
} from '../../../packages/cli/src/gateway-client.js';
import type { FleetStatusResult } from '../../../packages/protocol/src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(
  root,
  process.argv[2] ?? `temp/unconfirmed-read-release/${Date.now()}`,
);
await mkdir(evidence, { recursive: true });
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'unconfirmed-read-release-')));
// Not a local host name, so the gateway reaches the slot through the registered node.
const machine = 'unconfirmed-read-node';
const slotId = 'unconfirmed-read-slot';
const repo = path.join(fixture, 'slot');
const origin = path.join(fixture, 'origin.git');
const slowed = path.join(fixture, 'slow-read-started');
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.TMUX;
delete env.TMUX_PANE;
const stack = (extra: NodeJS.ProcessEnv) => ({ root, evidence, env: { ...env, ...extra } });
let gateway: ChildProcess | undefined;
let node: ChildProcess | undefined;
let connection: GatewayConnection | undefined;
const cleanupErrors: unknown[] = [];
const reaper = startReaper();
reaper.path(fixture);
const cleanup = cleanupOnExit(async () => {
  const attempt = (step: () => Promise<unknown>) =>
    step().catch((error: unknown) => cleanupErrors.push(error));
  connection?.close();
  await attempt(() => stopProcess(node));
  await attempt(() => stopProcess(gateway));
  await attempt(() => rm(fixture, { recursive: true, force: true }));
  reaper.done();
});

async function json(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    },
  ).trim();

let failure: unknown;
let result: Record<string, unknown> | undefined;
try {
  execFileSync('git', ['clone', '--shared', '--no-checkout', root, path.join(fixture, 'root')], {
    stdio: 'pipe',
  });
  const fixtureRoot = path.join(fixture, 'root');
  for (const entry of ['scripts', 'services', 'packages', 'node_modules', 'package.json'])
    await symlink(path.join(root, entry), path.join(fixtureRoot, entry));
  await writeFile(path.join(fixtureRoot, 'CLAUDE.md'), '# Isolated unconfirmed-read fixture\n');
  // The slot: a clean checkout of a real origin, so the workspace probe has a full answer.
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin], { stdio: 'pipe' });
  await mkdir(repo);
  git(repo, 'init', '-q', '--initial-branch=main');
  await writeFile(path.join(repo, 'README.md'), 'Fixture slot\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin', 'main');
  // The node's `git`: the first probe's branch read leaves a holder of its output in its own
  // session (so no process-group kill reaches it), as a stuck read on a loaded machine does.
  const shimDir = path.join(fixture, 'shim');
  await mkdir(shimDir);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  await writeFile(
    path.join(shimDir, 'git'),
    [
      '#!/bin/sh',
      'case "$*" in',
      `  *"${repo} symbolic-ref --quiet --short HEAD"*)`,
      `    if mkdir ${JSON.stringify(slowed)} 2>/dev/null; then`,
      `      perl -MPOSIX -e 'POSIX::setsid(); sleep 25' &`,
      '    fi;;',
      'esac',
      `exec ${JSON.stringify(realGit)} "$@"`,
      '',
    ].join('\n'),
  );
  await chmod(path.join(shimDir, 'git'), 0o755);
  const project = path.join(fixtureRoot, 'projects/unconfirmed-read');
  await json(path.join(project, 'project.json'), {
    name: 'unconfirmed-read',
    repo_url: origin,
    default_branch: 'main',
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
    execution_templates: { sources: [] },
  });
  await json(path.join(fixtureRoot, 'pool/unconfirmed-read.json'), {
    machine,
    host: `${machine}.invalid`,
    ssh_user: process.env.USER ?? 'operator',
    project: 'unconfirmed-read',
    platform: 'cli',
    os: process.platform,
    slots: [{ id: slotId, enabled: true, repo, session: slotId, resources: {} }],
  });
  await json(path.join(fixtureRoot, '.farm-status.json'), {
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: slotId,
        machine,
        project: 'unconfirmed-read',
        platform: 'cli',
        repo,
        session: slotId,
        lifecycle: 'ready',
        phase: null,
        agent: 'idle',
        enabled: true,
        health: { ssh: 'OK', device: '-', devserver: '-', fixtures: '-' },
      },
    ],
  });
  const port = await freePort();
  const token = testGatewayIdentity(path.join(fixtureRoot, 'home'), `ws://127.0.0.1:${port}`);
  gateway = startWorkspaceProcess(
    stack({
      FARMSLOT_ROOT: fixtureRoot,
      FARMSLOT_HOME: path.join(fixtureRoot, 'home'),
      FARMSLOT_PROJECTS_DIR: path.join(fixtureRoot, 'projects'),
      FARMSLOT_POOL_DIR: path.join(fixtureRoot, 'pool'),
      FARMSLOT_RUNS_DIR: path.join(fixtureRoot, 'runs'),
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      FARMSLOT_GATEWAY_PROFILE: 'proof',
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
    }),
    '@farmslot/gateway',
    'gateway.log',
  );
  reaper.group(gateway.pid);
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    timeout: 30_000,
    credential: { token },
  });
  connection = await poll(
    'the isolated gateway',
    async () => {
      if (gateway?.exitCode !== null) throw new Error('Isolated gateway exited before readiness');
      try {
        return await client.connect();
      } catch (error) {
        if (!(error instanceof GatewayConnectionError)) throw error;
        return undefined;
      }
    },
    60_000,
  );
  const gw = connection;
  const { principal } = await gw.call<{ principal: { id: string } }>('principal.create', {
    subject: { type: 'node', machine, displayName: 'Unconfirmed read fixture node' },
    roles: [],
  });
  const credential = await gw.call<{ secret: string }>('credential.issue', {
    principalId: principal.id,
    displayName: 'Unconfirmed read fixture node',
  });
  const nodeRoot = path.join(fixture, 'node');
  await mkdir(nodeRoot, { recursive: true });
  node = startWorkspaceProcess(
    stack({
      FARMSLOT_ROOT: nodeRoot,
      FARMSLOT_HOME: path.join(nodeRoot, 'home'),
      FARMSLOT_NODE_TOKEN: credential.secret,
      GATEWAY_URL: `ws://127.0.0.1:${port}`,
      MACHINE_NAME: machine,
      SCREEN_CONTROL_SOCKET: path.join(fixture, 'screen.sock'),
      PATH: `${shimDir}:${process.env.PATH}`,
    }),
    '@farmslot/node',
    'node.log',
  );
  reaper.group(node.pid);

  // Read the slot as an operator would, once a second, for up to 2 minutes.
  const timeline: Array<{ at: number; workspace: string | null; error: string | null }> = [];
  const started = Date.now();
  let sawUnconfirmed = false;
  const recovered = await poll(
    'the workspace to be observed again after the late closeout',
    async () => {
      const { fleet } = await gw.call<FleetStatusResult>('fleet.status');
      const row = fleet.slots.find((slot) => slot.slot === slotId);
      const entry = {
        at: Math.round((Date.now() - started) / 1000),
        workspace: row?.workspace?.branch ?? null,
        error: row?.workspaceError ?? null,
      };
      const last = timeline.at(-1);
      if (!last || last.workspace !== entry.workspace || last.error !== entry.error)
        timeline.push(entry);
      if (/unconfirmed closeout/.test(entry.error ?? '')) sawUnconfirmed = true;
      await delay(1000);
      return sawUnconfirmed && entry.workspace ? entry : undefined;
    },
    120_000,
  );
  await json(path.join(evidence, 'timeline.json'), timeline);
  assert.ok(sawUnconfirmed, 'the slow read was reported as an unconfirmed closeout first');
  assert.equal(recovered.workspace, 'main');
  result = { pass: true, evidence, recoveredAfterSeconds: recovered.at, timeline };
  await json(path.join(evidence, 'result.json'), result);
} catch (error) {
  failure = error;
  await json(path.join(evidence, 'failure.json'), { error: String(error), fixture });
} finally {
  await cleanup();
  if (cleanupErrors.length > 0)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      'Cleanup failed',
    );
}
if (failure) throw failure;
console.log(JSON.stringify(result));
