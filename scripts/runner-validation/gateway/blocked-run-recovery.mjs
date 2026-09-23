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

const sourceRoot = process.cwd();
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'farmslot-blocked-recovery-'));
const root = path.join(temporaryRoot, 'root');
const slotId = `blocked-recovery-${randomUUID()}`;
const runId = randomUUID();
const lostRunId = randomUUID();
const updateRunId = randomUUID();
const project = `blocked-recovery-${randomUUID()}`;
const repo = path.join(root, 'repo');
const startedAt = new Date(Date.now() - 120000).toISOString();
const blockedAt = new Date(Date.now() - 60000).toISOString();
let gateway;
let logFd;

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function blockedRun(id, ownedSlotId, flowType = 'fix-bug') {
  return {
    id,
    project,
    ticketOrPr: flowType === 'update-branch' ? 'deeeed/farmslot#721' : 'PROJ-999998',
    ...(flowType === 'update-branch' ? { prNumber: 721 } : {}),
    flowType,
    status: 'blocked',
    slotId: ownedSlotId,
    taskFile: path.join(repo, 'tasks', id, 'TASK.md'),
    createdAt: startedAt,
    updatedAt: blockedAt,
    decisions: [],
    metrics: { nudgeCount: 0, disposition: 'blocked', runner: 'scripted', model: null },
    steps: FLOW_STEPS[flowType].map((name) =>
      name === 'monitor'
        ? {
            name,
            status: 'done',
            startedAt,
            completedAt: blockedAt,
            outputs: { workerSignal: { status: 'blocked', timestamp: blockedAt } },
          }
        : { name, status: 'pending' },
    ),
  };
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
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(path.join(repo, 'README.md'), 'Disposable recovery fixture\n');
  execFileSync('git', ['-C', repo, 'add', 'README.md']);
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable recovery fixture\n');
  writeFileSync(path.join(root, 'scripts', 'dev.sh'), '#!/bin/sh\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture root',
  ]);
  writeJson(path.join(root, 'services', 'gateway', 'package.json'), {
    name: 'fixture',
    version: '0.0.0',
  });
  writeJson(path.join(root, 'pool', 'recovery.json'), {
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
  });
  writeJson(path.join(root, '.farm-status.json'), {
    slots: [{ slot: slotId, lifecycle: 'busy', phase: 'working', current_run_id: runId }],
  });
  for (const [id, ownedSlotId, flowType] of [
    [runId, slotId, 'fix-bug'],
    [lostRunId, 'unavailable-worker', 'fix-bug'],
    [updateRunId, 'unavailable-worker', 'update-branch'],
  ]) {
    const run = blockedRun(id, ownedSlotId, flowType);
    writeJson(path.join(root, '.runs', `${id}.json`), run);
    mkdirSync(path.dirname(run.taskFile), { recursive: true });
    writeFileSync(run.taskFile, '# Disposable blocked worker\n');
  }

  const port = await freePort();
  const env = {
    ...process.env,
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(temporaryRoot, 'home'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    NODE_TEST_CONTEXT: '1',
    FARMSLOT_DEMO_POOL: '0',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(port),
    FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
    TSX_TSCONFIG_PATH: path.join(sourceRoot, 'services/gateway/tsconfig.json'),
  };
  const rpc = (method, params) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
        { cwd: sourceRoot, env, encoding: 'utf8', timeout: 20000 },
      ),
    );
  const denied = (params, message) => {
    assert.throws(() => rpc('run.replayStep', params), message);
    const { run } = rpc('run.get', { runId: params.runId });
    assert.equal(run.status, 'blocked');
    assert.equal(run.steps.find((step) => step.name === 'monitor').status, 'done');
    return run;
  };

  logFd = openSync(path.join(temporaryRoot, 'gateway.log'), 'w');
  gateway = spawn(process.execPath, ['--import', 'tsx', 'services/gateway/src/index.ts'], {
    cwd: sourceRoot,
    env,
    stdio: ['ignore', logFd, logFd],
  });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (gateway.exitCode !== null) throw new Error('Fixture gateway exited during startup');
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Fixture gateway did not start');
  assert.equal(rpc('run.get', { runId }).run.status, 'blocked');

  const lost = denied({ runId: lostRunId, stepName: 'monitor' }, /no longer owns its slot/);
  assert.equal(lost.slotId, 'unavailable-worker');
  const update = denied(
    { runId: updateRunId, stepName: 'monitor' },
    /Start a new update-branch run/,
  );
  assert.equal(update.slotId, 'unavailable-worker');
  const blocked = denied({ runId, stepName: 'monitor' }, /Proof resources are not healthy/);
  assert.equal(blocked.slotId, slotId);

  rpc('run.replayStep', { runId, stepName: 'find-slot', triggeredBy: 'operator' });
  const restarted = rpc('run.get', { runId }).run;
  const slot = rpc('fleet.status', {}).fleet.slots.find((candidate) => candidate.slot === slotId);
  assert.equal(restarted.status, 'slot-finding');
  assert.equal(restarted.slotId, null);
  assert.equal(slot?.currentRunId, null);
  assert.equal(slot?.lifecycle, 'ready');
  assert.equal(restarted.steps.find((step) => step.name === 'find-slot').status, 'pending');
  console.log(
    JSON.stringify({
      runId,
      lostRunId,
      updateRunId,
      restart: restarted.status,
      slot: slot?.lifecycle,
    }),
  );
} catch (error) {
  if (logFd !== undefined)
    console.error(readFileSync(path.join(temporaryRoot, 'gateway.log'), 'utf8').slice(-4500));
  throw error;
} finally {
  if (gateway && gateway.exitCode === null) {
    const stopped = once(gateway, 'exit');
    gateway.kill('SIGTERM');
    await stopped;
  }
  if (logFd !== undefined) closeSync(logFd);
  rmSync(temporaryRoot, { recursive: true, force: true });
}
