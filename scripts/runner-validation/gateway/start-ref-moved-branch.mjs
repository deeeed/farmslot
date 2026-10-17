// Disposable-gateway proof that prepare accepts a start ref that is an older
// commit of a branch which has since moved and which the slot does not track,
// and still refuses a commit no advertised branch contains. No worker is
// dispatched: the dependency hook exits 42 right after the git phase.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { FLOW_STEPS } from '@farmslot/protocol';

import { testGatewayIdentity } from '../../lib/test-gateway-identity.mjs';
import {
  closeTmuxSandbox,
  GIT_LOCATION_ENV,
  openTmuxSandbox,
  tmuxSandboxEnvironment,
} from '../../quality/run-tsx-tests.mjs';

const sourceRoot = process.cwd();
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'farmslot-start-ref-moved-'));
const root = path.join(temporaryRoot, 'root');
const seed = path.join(temporaryRoot, 'seed');
const origin = path.join(temporaryRoot, 'origin.git');
const repo = path.join(temporaryRoot, 'repo');
const project = `start-ref-moved-${randomUUID()}`;
const slotId = `start-ref-moved-${randomUUID()}`;
const tmuxDir = openTmuxSandbox();
// An inherited GIT_DIR or GIT_INDEX_FILE (a hook, rebase --exec) would point
// fixture git and the gateway at the operator's repository instead.
const baseEnv = { ...process.env };
for (const key of GIT_LOCATION_ENV) delete baseEnv[key];
let gateway;
let logFd;

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, env: baseEnv, encoding: 'utf8', stdio: 'pipe' },
  ).trim();
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
  // Origin serves reachable commits by SHA, as GitHub does.
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin], {
    env: baseEnv,
    stdio: 'pipe',
  });
  git(origin, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '--initial-branch=main');
  writeFileSync(path.join(seed, 'README.md'), 'Disposable start-ref fixture\n');
  git(seed, 'add', 'README.md');
  git(seed, 'commit', '-qm', 'base');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  const baseSha = git(seed, 'rev-parse', 'HEAD');
  // A release range froze this commit; the release branch then moved on.
  git(seed, 'checkout', '-q', '-b', 'release/1.0.0');
  writeFileSync(path.join(seed, 'release.txt'), 'frozen\n');
  git(seed, 'add', 'release.txt');
  git(seed, 'commit', '-qm', 'frozen');
  const frozen = git(seed, 'rev-parse', 'HEAD');
  writeFileSync(path.join(seed, 'release.txt'), 'moved\n');
  git(seed, 'commit', '-qam', 'moved');
  git(seed, 'push', '-q', 'origin', 'release/1.0.0');
  // The slot clone tracks only main, and the release has no tag.
  execFileSync('git', ['clone', '-q', '--single-branch', '--branch', 'main', origin, repo], {
    env: baseEnv,
    stdio: 'pipe',
  });
  // Main then moves on: a later run freezes this commit.
  git(seed, 'checkout', '-q', 'main');
  writeFileSync(path.join(seed, 'later.txt'), 'later\n');
  git(seed, 'add', 'later.txt');
  git(seed, 'commit', '-qm', 'later on main');
  const mainLater = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', '-q', 'origin', 'main');
  const localOnly = git(
    repo,
    'commit-tree',
    'HEAD^{tree}',
    '-p',
    'HEAD',
    '-m',
    'local-only proof commit',
  );

  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable start-ref fixture\n');
  writeFileSync(path.join(root, 'scripts', 'dev.sh'), '#!/bin/sh\n');
  git(root, 'init', '-q');
  git(root, 'commit', '--allow-empty', '-qm', 'fixture root');
  writeJson(path.join(root, 'services', 'gateway', 'package.json'), {
    name: 'fixture',
    version: '0.0.0',
  });
  writeJson(path.join(root, 'pool', 'start-ref.json'), {
    machine: os.hostname(),
    host: 'localhost',
    ssh_user: os.userInfo().username,
    os: process.platform,
    slots: [
      {
        id: slotId,
        project,
        platform: 'cli',
        repo,
        session: slotId,
        enabled: true,
        mode: 'dispatch',
      },
    ],
  });
  writeJson(path.join(root, 'projects', project, 'project.json'), {
    name: project,
    type: 'monorepo',
    primary_repo: repo,
    default_branch: 'main',
    default_safety_tier: 'dangerous',
    task_dir: 'tasks',
    prepare: { default: 'proof', profiles: { proof: { phases: ['git', 'deps'] } } },
    hooks: { post_merge_install: 'echo intentional-proof-stop >&2; exit 42' },
  });
  writeJson(path.join(root, '.farm-status.json'), {
    checked_at: new Date().toISOString(),
    slots: [{ slot: slotId, lifecycle: 'ready', phase: 'idle', current_run_id: null }],
  });

  // A release-range QA run as admitted (fceb9861's shape): exact base and head,
  // frozen as the prepare start ref, whose prepare failed resolving that head.
  const qaRun = (id, headSha, status = 'failed') => {
    const taskFile = path.join(root, 'projects', project, 'tasks', 'qa', id, 'TASK.md');
    mkdirSync(path.dirname(taskFile), { recursive: true });
    writeFileSync(taskFile, '# Release validation proof\nNo implementation work.\n');
    const scope = { kind: 'range', base: baseSha, head: headSha };
    return {
      id,
      project,
      ticketOrPr: `Release validation proof ${id.slice(0, 8)}`,
      flowType: 'qa',
      mode: 'autonomous',
      status,
      ...(status === 'failed'
        ? { error: `startRef commit '${headSha}' is not reachable from fetched origin refs/tags` }
        : {}),
      slotId,
      taskFile,
      prepareProfile: 'proof',
      completionPolicy: 'artifact-only',
      qa: {
        profile: {
          id: 'release',
          title: 'Release validation',
          inputs: { scope: { kind: 'range' } },
        },
        inputs: { scope: { ...scope, expectedBaseSha: baseSha, expectedHeadSha: headSha } },
      },
      qaSource: { baseSha, headSha },
      startRef: { requestedRef: headSha, source: { kind: 'git-ref', ref: headSha } },
      createdAt: new Date(Date.now() - 120000).toISOString(),
      updatedAt: new Date(Date.now() - 60000).toISOString(),
      decisions: [],
      metrics: { nudgeCount: 0, outcome: 'partial', runner: 'claude', model: null },
      steps: FLOW_STEPS.qa.map((name) =>
        name === 'find-slot' || name === 'write-task'
          ? { name, status: 'done', ...(name === 'write-task' ? { outputs: { taskFile } } : {}) }
          : name === 'prepare'
            ? status === 'failed'
              ? { name, status: 'failed', detail: 'startRef commit is not reachable' }
              : { name, status: 'running', startedAt: new Date(Date.now() - 30000).toISOString() }
            : { name, status: status === 'failed' ? 'skipped' : 'pending' },
      ),
    };
  };
  const frozenRunId = randomUUID();
  const localOnlyRunId = randomUUID();
  writeJson(path.join(root, '.runs', `${frozenRunId}.json`), qaRun(frozenRunId, frozen));
  writeJson(path.join(root, '.runs', `${localOnlyRunId}.json`), qaRun(localOnlyRunId, localOnly));

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
      FARMSLOT_CAPABILITY_STORE_FILE: path.join(root, '.runs', 'runtime-capabilities.json'),
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
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

  const startGateway = async (gatewayEnv = env) => {
    logFd = openSync(path.join(temporaryRoot, 'gateway.log'), 'a');
    gateway = spawn(process.execPath, ['--import', 'tsx', 'services/gateway/src/index.ts'], {
      cwd: sourceRoot,
      env: gatewayEnv,
      stdio: ['ignore', logFd, logFd],
    });
    for (let attempt = 0; ; attempt++) {
      if (gateway.exitCode !== null || gateway.signalCode !== null)
        throw new Error('Fixture gateway exited during startup');
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
      if (attempt >= 450) throw new Error('Fixture gateway did not start');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const stopGateway = async () => {
    if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
      const stopped = once(gateway, 'exit');
      gateway.kill('SIGTERM');
      await stopped;
    }
    if (logFd !== undefined) closeSync(logFd);
    logFd = undefined;
  };
  await startGateway();

  // Replay prepare through RPC; the deps hook stops it before any dispatch.
  const stopped = async (runId) => {
    for (const deadline = Date.now() + 120000; Date.now() < deadline; ) {
      const current = rpc('run.get', { runId }).run;
      const slot = rpc('fleet.status', {}).fleet.slots.find((s) => s.slot === slotId);
      if (current.status === 'failed' && slot?.lifecycle === 'ready' && !slot.current_run_id) {
        return current;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Run ${runId} did not stop at the proof boundary`);
  };
  const prepareAt = (runId) => {
    rpc('run.replayStep', { runId, stepName: 'prepare', triggeredBy: 'operator' });
    return stopped(runId);
  };
  const leftDetached = (run) =>
    run.steps
      .find((step) => step.name === 'prepare')
      .outputs.subSteps.some(
        (step) =>
          step.name === 'branch' &&
          /^(Left detached|Detached) [0-9a-f]+, which origin contains/.test(step.detail),
      );

  const moved = await prepareAt(frozenRunId);
  assert.doesNotMatch(moved.error, /not reachable/, 'the moved-branch commit resolves');
  assert.match(moved.error, /exit 42/, 'prepare got past start-ref resolution to the deps hook');
  const startRefStep = moved.steps
    .find((step) => step.name === 'prepare')
    .outputs.subSteps.find((step) => step.name === 'start-ref' && /resolved to/.test(step.detail));
  assert.match(startRefStep.detail, new RegExp(`resolved to ${frozen}`));
  assert.equal(
    git(repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/release'),
    '',
    'resolution wrote no release-branch ref into the slot clone',
  );
  assert.equal(git(repo, 'rev-parse', 'HEAD'), frozen, 'prepare checked out the frozen head');

  // The failed prepare left the slot detached at that head. A replay of the same
  // run, then a different run, must prepare from it without an operator release.
  const replayed = await prepareAt(frozenRunId);
  assert.match(replayed.error, /exit 42/, 'a prepare replay from the detached slot reaches deps');
  assert.ok(leftDetached(replayed), 'the replay moved the slot off its detached head first');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), frozen);

  // A fresh prepare (no replay, so the unpublished-commit check runs): a run left
  // preparing when the gateway stopped is re-driven by restart recovery.
  await stopGateway();
  const freshRunId = randomUUID();
  writeJson(
    path.join(root, '.runs', `${freshRunId}.json`),
    qaRun(freshRunId, mainLater, 'preparing'),
  );
  const status = JSON.parse(readFileSync(path.join(root, '.farm-status.json'), 'utf8'));
  status.slots = status.slots.map((row) =>
    row.slot === slotId
      ? {
          ...row,
          lifecycle: 'busy',
          phase: 'preparing',
          agent: 'orchestrator',
          current_run_id: freshRunId,
        }
      : row,
  );
  writeJson(path.join(root, '.farm-status.json'), status);
  // Startup run recovery is part of orchestration; this root has no backlog or auto-recovery.
  const { FARMSLOT_DISABLE_ORCHESTRATION: _orchestrationOff, ...recoveringEnv } = env;
  await startGateway(recoveringEnv);
  const fresh = await stopped(freshRunId);
  assert.doesNotMatch(fresh.error, /Slot is on 'HEAD'|unpushed commits/);
  assert.match(fresh.error, /exit 42/, 'a fresh prepare from the detached slot reaches deps');
  assert.ok(leftDetached(fresh), 'the fresh prepare moved the slot off its detached head first');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), mainLater);

  // A refused start-ref prepare keeps the detached slot and the changes on it.
  writeFileSync(path.join(repo, 'later.txt'), 'evidence from the failed run\n');
  const refused = await prepareAt(localOnlyRunId);
  assert.doesNotMatch(refused.error, /Slot is on 'HEAD'|unpushed commits/);
  assert.match(refused.error, /not reachable from fetched origin/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), mainLater, 'the refusal left HEAD where it was');
  assert.equal(git(repo, 'status', '--porcelain'), 'M later.txt', 'the refusal kept the change');

  console.log(
    JSON.stringify({
      frozen,
      movedBranchResolved: true,
      preparedToDepsHook: true,
      slotRefsUnchanged: true,
      replayFromDetachedSlot: true,
      freshPrepareFromDetachedSlot: true,
      localOnlyRefused: true,
      refusalKeptDetachedChanges: true,
    }),
  );
} catch (error) {
  if (logFd !== undefined)
    console.error(readFileSync(path.join(temporaryRoot, 'gateway.log'), 'utf8').slice(-4500));
  throw error;
} finally {
  if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
    const exited = once(gateway, 'exit');
    gateway.kill('SIGTERM');
    await exited;
  }
  if (logFd !== undefined) closeSync(logFd);
  closeTmuxSandbox(tmuxSandboxEnvironment(baseEnv, tmuxDir));
  rmSync(temporaryRoot, { recursive: true, force: true });
}
