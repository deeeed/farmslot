#!/usr/bin/env tsx
// Live proof (F286) that a pr-complete dispatch preview names the acceptance criteria the run will
// be held to: its parent run's original ones, not any given with it. 9f0b6812, a CI-fix
// pr-complete, was held to family 8a768552's AC1-AC4 without the preview saying so.
//
// An isolated gateway (own pool, projects, runs and home) holds two finished dev runs that opened
// PRs: one with registered criteria, one whose ticket has none. `dispatch.preview` over a real
// WebSocket, and `farmslot dispatch preview` against the same gateway, must name the first one's
// criteria and say why the second one's can't be read. `gh` is a failing fixture, so nothing
// reaches GitHub.
//
// Run: yarn tsx scripts/runner-validation/gateway/preview-inherited-acceptance.mts [evidence-dir]
import { testGatewayIdentity } from '../../lib/test-gateway-identity-source.mjs';
import assert from 'node:assert/strict';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import type { DispatchPreviewResult } from '../../../packages/protocol/src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(
  root,
  process.argv[2] ?? `temp/preview-inherited-acceptance/${Date.now()}`,
);
await mkdir(evidence, { recursive: true });
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'preview-inherited-acs-')));
const project = 'inherited-acs';
const slotId = 'inherited-acs-slot';
const repo = path.join(fixture, 'slot');
const home = path.join(fixture, 'home');
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.TMUX;
delete env.TMUX_PANE;
let gateway: ChildProcess | undefined;
let connection: GatewayConnection | undefined;
const cleanupErrors: unknown[] = [];
const reaper = startReaper();
reaper.path(fixture);
const cleanup = cleanupOnExit(async () => {
  const attempt = (step: () => Promise<unknown>) =>
    step().catch((error: unknown) => cleanupErrors.push(error));
  connection?.close();
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
    { cwd, encoding: 'utf8', stdio: 'pipe' },
  ).trim();
/** A finished dev run that opened PR `prNumber`; `criteria` undefined leaves its ticket without any. */
function parentRun(prNumber: number, criteria?: string[]) {
  const id = randomUUID();
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return {
    id,
    project,
    ticketOrPr: `APP-${prNumber}`,
    flowType: 'dev',
    status: 'done',
    prNumber,
    branch: `feat/app-${prNumber}`,
    taskFile: path.join(repo, 'tasks', id, 'TASK.md'),
    createdAt: at,
    updatedAt: at,
    decisions: [],
    steps: [],
    metrics: { nudgeCount: 0, disposition: 'completed', runner: 'scripted', model: null },
    ticketData: {
      source: 'manual',
      title: `App change ${prNumber}`,
      description: '',
      affectedArea: '',
      ...(criteria ? { acceptanceCriteria: criteria } : {}),
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
  };
}

let failure: unknown;
let result: Record<string, unknown> | undefined;
try {
  execFileSync('git', ['clone', '--shared', '--no-checkout', root, path.join(fixture, 'root')], {
    stdio: 'pipe',
  });
  const fixtureRoot = path.join(fixture, 'root');
  for (const entry of ['scripts', 'services', 'packages', 'node_modules', 'package.json'])
    await symlink(path.join(root, entry), path.join(fixtureRoot, entry));
  await writeFile(path.join(fixtureRoot, 'CLAUDE.md'), '# Isolated inherited-acceptance fixture\n');
  const origin = path.join(fixture, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin], { stdio: 'pipe' });
  await mkdir(repo);
  git(repo, 'init', '-q', '--initial-branch=main');
  await writeFile(path.join(repo, 'README.md'), 'Fixture slot\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  const withCriteria = parentRun(4242, [
    'Every direct dependency is on its latest stable version.',
    'The test suite passes.',
  ]);
  const withoutCriteria = parentRun(4243);
  for (const run of [withCriteria, withoutCriteria]) {
    await mkdir(path.dirname(run.taskFile), { recursive: true });
    await writeFile(run.taskFile, `# ${run.ticketOrPr}\n`);
    await json(path.join(fixtureRoot, 'runs', `${run.id}.json`), run);
  }
  await json(path.join(fixtureRoot, 'projects', project, 'project.json'), {
    name: project,
    repo_url: origin,
    default_branch: 'main',
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
    execution_templates: { sources: [] },
  });
  await json(path.join(fixtureRoot, 'pool', `${project}.json`), {
    machine: 'localhost',
    host: 'localhost',
    ssh_user: process.env.USER ?? 'operator',
    project,
    platform: 'cli',
    os: process.platform,
    slots: [{ id: slotId, enabled: true, repo, session: slotId, resources: {} }],
  });
  await json(path.join(fixtureRoot, '.farm-status.json'), {
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: slotId,
        machine: 'localhost',
        project,
        platform: 'cli',
        repo,
        session: slotId,
        lifecycle: 'ready',
        phase: null,
        agent: 'idle',
        enabled: true,
        health: { ssh: 'LOCAL', device: '-', devserver: '-', fixtures: '-' },
      },
    ],
  });
  // A preview reads ticket metadata best-effort; this keeps it off GitHub.
  const shimDir = path.join(fixture, 'shim');
  await mkdir(shimDir);
  await writeFile(
    path.join(shimDir, 'gh'),
    '#!/bin/sh\necho "gh is disabled in this fixture" >&2\nexit 1\n',
  );
  await chmod(path.join(shimDir, 'gh'), 0o755);
  const port = await freePort();
  const url = `ws://127.0.0.1:${port}`;
  const token = testGatewayIdentity(home, url);
  gateway = startWorkspaceProcess(
    {
      root,
      evidence,
      env: {
        ...env,
        PATH: `${shimDir}:${process.env.PATH}`,
        FARMSLOT_ROOT: fixtureRoot,
        FARMSLOT_HOME: home,
        FARMSLOT_PROJECTS_DIR: path.join(fixtureRoot, 'projects'),
        FARMSLOT_POOL_DIR: path.join(fixtureRoot, 'pool'),
        FARMSLOT_RUNS_DIR: path.join(fixtureRoot, 'runs'),
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PORT: String(port),
        FARMSLOT_GATEWAY_PROFILE: 'proof',
        FARMSLOT_DISABLE_ORCHESTRATION: '1',
      },
    },
    '@farmslot/gateway',
    'gateway.log',
  );
  reaper.group(gateway.pid);
  const client = new GatewayClient({ url, timeout: 60_000, credential: { token } });
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
  const preview = async (prNumber: number) =>
    (
      await gw.call<DispatchPreviewResult>('dispatch.preview', {
        project,
        flowType: 'pr-complete',
        ticketOrPr: `acme/app#${prNumber}`,
        mode: 'autonomous',
      })
    ).preview;
  const named = await preview(4242);
  await json(path.join(evidence, 'preview-4242.json'), named);
  assert.deepEqual(named.inheritedAcceptance, {
    fromRunId: withCriteria.id,
    criteria: [
      { id: 'AC-1', text: 'Every direct dependency is on its latest stable version.' },
      { id: 'AC-2', text: 'The test suite passes.' },
    ],
  });
  const unreadable = await preview(4243);
  await json(path.join(evidence, 'preview-4243.json'), unreadable);
  assert.equal(unreadable.inheritedAcceptance?.fromRunId, withoutCriteria.id);
  assert.deepEqual(unreadable.inheritedAcceptance?.criteria, []);
  assert.match(
    unreadable.inheritedAcceptance?.unavailable ?? '',
    /parent ticketData\.acceptanceCriteria is unavailable/,
  );
  // The operator's view: the CLI against the same gateway (its profile is in the proof's home).
  const cli = (prNumber: number) =>
    execFileSync(
      process.execPath,
      [
        path.join(root, 'packages/cli/bin/farmslot.mjs'),
        'dispatch',
        'preview',
        '--project',
        project,
        '--flow-type',
        'pr-complete',
        '--ticket',
        `acme/app#${prNumber}`,
        '--mode',
        'autonomous',
      ],
      { encoding: 'utf8', env: { ...env, FARMSLOT_HOME: home, NO_COLOR: '1' }, timeout: 90_000 },
    );
  const printed = cli(4242);
  const printedUnreadable = cli(4243);
  await writeFile(path.join(evidence, 'cli-4242.txt'), printed);
  await writeFile(path.join(evidence, 'cli-4243.txt'), printedUnreadable);
  assert.match(
    printed,
    new RegExp(
      `Acceptance: 2 criteria inherited from run ${withCriteria.id.slice(0, 8)}; any given with this run are not used`,
    ),
  );
  assert.match(printed, /AC-1: Every direct dependency is on its latest stable version\./);
  assert.match(printed, /AC-2: The test suite passes\./);
  assert.match(
    printedUnreadable,
    new RegExp(`Acceptance: inherited from run ${withoutCriteria.id.slice(0, 8)}, unreadable: `),
  );
  result = {
    pass: true,
    evidence,
    inherited: named.inheritedAcceptance,
    unreadable: unreadable.inheritedAcceptance,
  };
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
