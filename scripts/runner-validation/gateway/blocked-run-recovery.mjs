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
  symlinkSync,
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
const successRunId = randomUUID();
const project = `blocked-recovery-${randomUUID()}`;
const repo = path.join(root, 'repo');
const startedAt = new Date(Date.now() - 120000).toISOString();
const blockedAt = new Date(Date.now() - 60000).toISOString();
let gateway;
let logFd;
let workerSession = false;

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function blockedRun(id, ownedSlotId, flowType = 'fix-bug', readyForMonitor = false) {
  const taskFile = path.join(repo, 'tasks', id, 'TASK.md');
  return {
    id,
    project,
    ticketOrPr: flowType === 'update-branch' ? 'deeeed/farmslot#721' : 'PROJ-999998',
    ...(flowType === 'update-branch' ? { prNumber: 721 } : {}),
    flowType,
    status: 'blocked',
    slotId: ownedSlotId,
    taskFile,
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
            outputs: {
              workerSignal: {
                status: 'blocked',
                attemptId: 'blocked-attempt',
                timestamp: blockedAt,
              },
            },
          }
        : {
            name,
            status:
              readyForMonitor &&
              FLOW_STEPS[flowType].indexOf(name) < FLOW_STEPS[flowType].indexOf('monitor')
                ? 'done'
                : 'pending',
            ...(readyForMonitor && name === 'write-task' ? { outputs: { taskFile } } : {}),
          },
    ),
    ...(readyForMonitor
      ? {
          agentContexts: [
            {
              id: 'worker',
              role: 'fix-bug',
              status: 'blocked',
              runId: id,
              slotId: ownedSlotId,
              taskFile,
              signalFile: path.join(path.dirname(taskFile), 'SIGNAL.json'),
            },
          ],
        }
      : {}),
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

async function startGateway(port, env) {
  const processHandle = spawn(
    process.execPath,
    ['--import', 'tsx', 'services/gateway/src/index.ts'],
    {
      cwd: sourceRoot,
      env,
      stdio: ['ignore', logFd, logFd],
    },
  );
  for (let attempt = 0; attempt < 450; attempt++) {
    if (processHandle.exitCode !== null) throw new Error('Fixture gateway exited during startup');
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return processHandle;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Fixture gateway did not start: ${readFileSync(path.join(temporaryRoot, 'gateway.log'), 'utf8').slice(-1000)}`,
  );
}

async function stopGateway() {
  if (gateway && gateway.exitCode === null) {
    const stopped = once(gateway, 'exit');
    gateway.kill('SIGTERM');
    await stopped;
  }
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
    task_dir: 'tasks',
    slot_actions: {
      'proof-check': { label: 'Check proof resource', command: 'true' },
    },
    runtime_capabilities: {
      providers: {
        'proof-resource': {
          label: 'Disposable proof resource',
          version: '1',
          share_policy: 'exclusive',
          cost: { class: 'low', resources: [] },
          actions: {
            acquire: { kind: 'slot-action', action_id: 'proof-check' },
            health: { kind: 'slot-action', action_id: 'proof-check' },
            release: { kind: 'slot-action', action_id: 'proof-check' },
          },
          release_effects: ['Disposable proof resource released'],
        },
      },
    },
    worker_terminal: {
      requireSignal: true,
      flows: { 'fix-bug': { acceptance: { require: true } } },
    },
  });
  writeJson(path.join(root, '.farm-status.json'), {
    slots: [{ slot: slotId, lifecycle: 'busy', phase: 'working', current_run_id: runId }],
  });
  for (const [id, ownedSlotId, flowType] of [
    [runId, slotId, 'fix-bug'],
    [lostRunId, 'unavailable-worker', 'fix-bug'],
    [updateRunId, 'unavailable-worker', 'update-branch'],
  ]) {
    const run = blockedRun(id, ownedSlotId, flowType, id === successRunId);
    writeJson(path.join(root, '.runs', `${id}.json`), run);
    mkdirSync(path.dirname(run.taskFile), { recursive: true });
    writeFileSync(run.taskFile, '# Disposable blocked worker\n');
  }
  const successTaskDir = path.join(repo, 'tasks', successRunId);
  const signalFile = path.join(successTaskDir, 'SIGNAL.json');
  writeJson(path.join(successTaskDir, 'inputs', 'handoff.json'), {
    task: {
      acceptanceCriteria: ['A fresh worker attempt can complete after proof resources recover'],
    },
  });
  writeJson(path.join(successTaskDir, 'inputs', 'worker-terminal-contract.json'), {
    schemaVersion: 1,
    flowType: 'fix-bug',
    requireSignal: true,
    acceptance: { require: true },
    commands: {
      complete: {
        report: 'artifacts/pr-description.md',
        artifacts: ['artifacts/learnings.md', 'artifacts/pr-description.md'],
      },
    },
    whenPresent: [],
  });
  writeFileSync(path.join(successTaskDir, 'CHECKLIST.md'), '- [x] Verify proof\n');
  mkdirSync(path.join(successTaskDir, 'artifacts'), { recursive: true });
  for (const artifact of ['learnings.md', 'pr-description.md']) {
    writeFileSync(
      path.join(successTaskDir, 'artifacts', artifact),
      `# ${artifact}\nFixture proof.\n`,
    );
  }
  mkdirSync(path.join(root, 'packages', 'agent-runtime'), { recursive: true });
  symlinkSync(
    path.join(sourceRoot, 'packages', 'agent-runtime', 'scripts'),
    path.join(root, 'packages', 'agent-runtime', 'scripts'),
    'dir',
  );

  const port = await freePort();
  const env = {
    ...process.env,
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(temporaryRoot, 'home'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
    FARMSLOT_CAPABILITY_STORE_FILE: path.join(root, '.runs', 'runtime-capabilities.json'),
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    NODE_TEST_CONTEXT: '1',
    FARMSLOT_DEMO_POOL: '0',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(port),
    FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
    FARMSLOT_RPC_TIMEOUT_MS: '25000',
    TSX_TSCONFIG_PATH: path.join(sourceRoot, 'services/gateway/tsconfig.json'),
  };
  const rpc = (method, params) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
        { cwd: sourceRoot, env, encoding: 'utf8', timeout: 40000 },
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
  gateway = await startGateway(port, env);
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
  await stopGateway();
  writeJson(
    path.join(root, '.runs', `${successRunId}.json`),
    blockedRun(successRunId, slotId, 'fix-bug', true),
  );
  writeJson(path.join(root, '.farm-status.json'), {
    slots: [{ slot: slotId, lifecycle: 'busy', phase: 'working', current_run_id: successRunId }],
  });
  execFileSync('tmux', ['new-session', '-d', '-s', slotId, '-c', repo, 'sleep 300']);
  workerSession = true;
  gateway = await startGateway(port, { ...env, FARMSLOT_DISABLE_RUN_ENGINE_START: '0' });
  assert.equal(rpc('run.get', { runId: successRunId }).run.slotId, slotId);
  const acquired = rpc('runtime.capability.acquire', {
    slotId,
    capabilityId: 'proof-resource',
    ownerRunId: successRunId,
    proofRequirement: {
      capabilityId: 'proof-resource',
      reason: 'blocked worker proof',
      mode: 'state',
    },
  });
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  const proof = rpc('runtime.capability.status', { slotId, ownerRunId: successRunId });
  assert.equal(proof.proofPlans[successRunId]?.requirements[0].capabilityId, 'proof-resource');
  assert.ok(Date.parse(proof.leases[0].health.checkedAt) > Date.parse(blockedAt));

  const nextAttempt = randomUUID();
  writeJson(signalFile, {
    status: 'running',
    attemptId: 'blocked-attempt',
    timestamp: new Date().toISOString(),
  });
  denied({ runId: successRunId, stepName: 'monitor' }, /status is/);
  const signal = {
    status: 'complete',
    outcome: 'success',
    attemptId: nextAttempt,
    timestamp: new Date().toISOString(),
  };
  writeJson(signalFile, signal);
  const unassessed = rpc('run.probeWorkerSignal', { runId: successRunId });
  assert.equal(unassessed.code, 'artifact_contract', JSON.stringify(unassessed));
  assert.match(unassessed.message, /acceptance-status.json|AC-1/);
  execFileSync(
    path.join(sourceRoot, 'node_modules', '.bin', 'farmslot-agent'),
    [
      'ac',
      'set',
      'AC-1',
      'proven',
      '--proof-mode',
      'state',
      '--evidence',
      'artifacts/pr-description.md',
      '--task-dir',
      successTaskDir,
    ],
    { cwd: sourceRoot, stdio: 'pipe' },
  );
  const assessed = rpc('run.probeWorkerSignal', { runId: successRunId });
  assert.equal(assessed.code, 'ready', JSON.stringify(assessed));
  writeJson(signalFile, {
    status: 'running',
    attemptId: nextAttempt,
    timestamp: new Date().toISOString(),
  });
  const resumed = rpc('run.replayStep', {
    runId: successRunId,
    stepName: 'monitor',
    triggeredBy: 'operator',
  });
  assert.equal(resumed.run.status, 'monitoring');
  const working = rpc('fleet.status', {}).fleet.slots.find(
    (candidate) => candidate.slot === slotId,
  );
  assert.equal(working.phase, 'working');
  assert.equal(working.agent, 'working');
  writeJson(signalFile, { ...signal, timestamp: new Date().toISOString() });
  let monitored;
  for (let attempt = 0; attempt < 100; attempt++) {
    monitored = rpc('run.get', { runId: successRunId }).run;
    if (monitored.steps.find((step) => step.name === 'monitor')?.status === 'done') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(monitored.steps.find((step) => step.name === 'monitor')?.status, 'done');
  console.log(
    JSON.stringify({
      runId,
      lostRunId,
      updateRunId,
      restart: restarted.status,
      slot: slot?.lifecycle,
      successRunId,
      acceptance: assessed.code,
      monitor: monitored.steps.find((step) => step.name === 'monitor')?.status,
    }),
  );
} catch (error) {
  if (logFd !== undefined)
    console.error(readFileSync(path.join(temporaryRoot, 'gateway.log'), 'utf8').slice(-4500));
  throw error;
} finally {
  await stopGateway();
  if (workerSession) execFileSync('tmux', ['kill-session', '-t', slotId]);
  if (logFd !== undefined) closeSync(logFd);
  rmSync(temporaryRoot, { recursive: true, force: true });
}
