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
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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
const lostEvalRunId = randomUUID();
const updateRunId = randomUUID();
const successRunId = randomUUID();
const evalRunId = randomUUID();
const rollbackRunId = randomUUID();
const freeRollbackRunId = randomUUID();
const rollbackFailureRunId = randomUUID();
const freeRollbackSlotId = `free-rollback-${randomUUID()}`;
const rollbackSlotId = `blocked-rollback-${randomUUID()}`;
const evalSlotId = `blocked-eval-${randomUUID()}`;
const project = `blocked-recovery-${randomUUID()}`;
const repo = path.join(root, 'repo');
const startedAt = new Date(Date.now() - 120000).toISOString();
const blockedAt = new Date(Date.now() - 60000).toISOString();
let gateway;
let logFd;
let workerSession = false;
let rollbackWorkerSession = false;

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function blockedRun(
  id,
  ownedSlotId,
  flowType = 'fix-bug',
  readyForMonitor = false,
  signalAt = blockedAt,
) {
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
                timestamp: signalAt,
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
              signalAttemptId: 'blocked-attempt',
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
      {
        id: evalSlotId,
        project,
        platform: 'cli',
        repo,
        session: evalSlotId,
        enabled: true,
        mode: 'dispatch',
      },
      {
        id: rollbackSlotId,
        project,
        platform: 'cli',
        repo,
        session: rollbackSlotId,
        enabled: true,
        mode: 'dispatch',
      },
      {
        id: freeRollbackSlotId,
        project,
        platform: 'cli',
        repo,
        session: freeRollbackSlotId,
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
        'proof-dependent': {
          label: 'Disposable dependent proof resource',
          version: '1',
          share_policy: 'exclusive',
          dependencies: ['proof-resource'],
          cost: { class: 'low', resources: [] },
          actions: {
            acquire: { kind: 'slot-action', action_id: 'proof-check' },
            health: { kind: 'slot-action', action_id: 'proof-check' },
            release: { kind: 'slot-action', action_id: 'proof-check' },
          },
          release_effects: ['Disposable dependent proof resource released'],
        },
      },
    },
    worker_terminal: {
      requireSignal: true,
      flows: { 'fix-bug': { acceptance: { require: true } } },
    },
  });
  const initialFleetCheckedAt = new Date().toISOString();
  writeJson(path.join(root, '.farm-status.json'), {
    checked_at: initialFleetCheckedAt,
    slots: [
      { slot: slotId, lifecycle: 'busy', phase: 'working', current_run_id: runId },
      { slot: evalSlotId, lifecycle: 'busy', phase: 'working', current_run_id: evalRunId },
      {
        slot: rollbackSlotId,
        lifecycle: 'held',
        phase: 'pr-watch',
        agent: 'idle',
        current_run_id: rollbackRunId,
      },
      { slot: freeRollbackSlotId, lifecycle: 'ready', phase: 'idle', current_run_id: null },
    ],
  });
  for (const [id, ownedSlotId, flowType] of [
    [runId, slotId, 'fix-bug'],
    [lostRunId, 'unavailable-worker', 'fix-bug'],
    [lostEvalRunId, 'unavailable-worker', 'fix-bug'],
    [updateRunId, 'unavailable-worker', 'update-branch'],
  ]) {
    const run = blockedRun(id, ownedSlotId, flowType);
    if (id === lostEvalRunId) {
      run.engineState = {
        evalExperiment: {
          experimentId: 'experiment-lost-slot',
          experimentKey: 'experiment-key-lost-slot',
          experimentManifestPath: '/tmp/experiment-manifest.json',
          packagePath: '/tmp/candidate.result-package.json',
          candidateStrategyFingerprint: 'fingerprint-lost-slot',
          trialId: 'trial-lost-slot',
        },
      };
    }
    writeJson(path.join(root, '.runs', `${id}.json`), run);
    mkdirSync(path.dirname(run.taskFile), { recursive: true });
    writeFileSync(run.taskFile, '# Disposable blocked worker\n');
  }
  const evalRun = blockedRun(evalRunId, evalSlotId, 'fix-bug', true);
  evalRun.engineState = {
    evalExperiment: {
      experimentId: 'experiment-blocked',
      experimentKey: 'experiment-key-blocked',
      experimentManifestPath: '/tmp/experiment-manifest.json',
      packagePath: '/tmp/candidate.result-package.json',
      candidateStrategyFingerprint: 'fingerprint-blocked',
      trialId: 'trial-blocked',
    },
  };
  const rollbackRun = blockedRun(rollbackRunId, rollbackSlotId, 'fix-bug', true);
  rollbackRun.engineState = evalRun.engineState;
  const freeRollbackRun = blockedRun(freeRollbackRunId, null);
  freeRollbackRun.steps.find((step) => step.name === 'find-slot').outputs = {
    selectedSlot: freeRollbackSlotId,
  };
  writeJson(path.join(root, '.runs', `${freeRollbackRunId}.json`), freeRollbackRun);
  const rollbackFailureRun = blockedRun(rollbackFailureRunId, null);
  rollbackFailureRun.steps.find((step) => step.name === 'find-slot').outputs = {
    selectedSlot: freeRollbackSlotId,
  };
  writeJson(path.join(root, '.runs', `${rollbackFailureRunId}.json`), rollbackFailureRun);
  writeJson(path.join(root, '.runs', `${rollbackRunId}.json`), rollbackRun);
  mkdirSync(path.dirname(rollbackRun.taskFile), { recursive: true });
  writeFileSync(rollbackRun.taskFile, '# Disposable blocked rollback worker\n');
  execFileSync('tmux', ['new-session', '-d', '-s', rollbackSlotId, '-c', repo, 'sleep 300']);
  rollbackWorkerSession = true;
  writeJson(path.join(root, '.runs', `${evalRunId}.json`), evalRun);
  mkdirSync(path.dirname(evalRun.taskFile), { recursive: true });
  writeFileSync(evalRun.taskFile, '# Disposable blocked eval worker\n');
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
    FARMSLOT_TEST_REPLAY_FAIL_AFTER_CLAIM_RUN_IDS: `${rollbackRunId},${freeRollbackRunId},${rollbackFailureRunId}`,
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
  assert.equal(rpc('fleet.status', {}).fleet.checkedAt, initialFleetCheckedAt);
  assert.equal(rpc('run.get', { runId }).run.status, 'blocked');

  const lost = denied({ runId: lostRunId, stepName: 'monitor' }, /no longer owns its slot/);
  assert.equal(lost.slotId, 'unavailable-worker');
  const lostEval = rpc('run.replayStep', { runId: lostEvalRunId, stepName: 'monitor' });
  assert.equal(lostEval.run.status, 'slot-finding');
  assert.equal(lostEval.run.slotId, null);
  assert.equal(lostEval.run.recoveryAttempts?.at(-1)?.stepName, 'find-slot');
  const update = denied(
    { runId: updateRunId, stepName: 'monitor' },
    /Start a new update-branch run/,
  );
  assert.equal(update.slotId, 'unavailable-worker');
  const evalReplay = rpc('run.replayStep', { runId: evalRunId, stepName: 'monitor' });
  assert.equal(evalReplay.run.recoveryAttempts?.at(-1)?.stepName, 'prepare');
  assert.equal(evalReplay.run.status, 'preparing');
  const evalAcquire = rpc('runtime.capability.acquire', {
    slotId: evalSlotId,
    capabilityId: 'proof-resource',
    ownerRunId: evalRunId,
    proofRequirement: {
      capabilityId: 'proof-resource',
      reason: 'restarted eval worker proof',
      mode: 'state',
    },
  });
  assert.equal(evalAcquire.ok, true, JSON.stringify(evalAcquire));
  const evalRelease = rpc('runtime.capability.release', {
    slotId: evalSlotId,
    ownerRunId: evalRunId,
    capabilityId: 'proof-resource',
    keepWarm: false,
  });
  assert.equal(evalRelease.ok, true, JSON.stringify(evalRelease));
  const rollbackHeld = rpc('runtime.capability.acquire', {
    slotId: rollbackSlotId,
    capabilityId: 'proof-resource',
    ownerRunId: rollbackRunId,
    proofRequirement: {
      capabilityId: 'proof-resource',
      reason: 'held rollback proof',
      mode: 'state',
    },
  });
  assert.equal(rollbackHeld.ok, true, JSON.stringify(rollbackHeld));
  const heldLease = rpc('runtime.capability.status', {
    slotId: rollbackSlotId,
    ownerRunId: rollbackRunId,
  }).leases.find((lease) => lease.owner.runId === rollbackRunId);
  assert.equal(heldLease?.state, 'acquired');
  const beforeRollback = JSON.parse(
    readFileSync(path.join(root, '.farm-status.json'), 'utf8'),
  ).slots.find((candidate) => candidate.slot === rollbackSlotId);
  assert.equal(beforeRollback?.current_run_id, rollbackRunId);
  const rolledBack = denied(
    { runId: rollbackRunId, stepName: 'monitor' },
    /Injected replay failure after claim/,
  );
  assert.equal(rolledBack.slotId, rollbackSlotId);
  const restoredRow = JSON.parse(
    readFileSync(path.join(root, '.farm-status.json'), 'utf8'),
  ).slots.find((candidate) => candidate.slot === rollbackSlotId);
  assert.equal(restoredRow?.current_run_id, rollbackRunId);
  assert.equal(restoredRow?.lifecycle, beforeRollback.lifecycle);
  assert.equal(restoredRow?.phase, beforeRollback.phase);
  assert.equal(restoredRow?.agent, beforeRollback.agent);
  const rollbackSlot = rpc('fleet.status', {}).fleet.slots.find(
    (candidate) => candidate.slot === rollbackSlotId,
  );
  assert.equal(rollbackSlot?.currentRunId, rollbackRunId);
  execFileSync('tmux', ['has-session', '-t', rollbackSlotId]);
  const restoredLease = rpc('runtime.capability.status', {
    slotId: rollbackSlotId,
    ownerRunId: rollbackRunId,
  }).leases.find((lease) => lease.id === heldLease.id);
  assert.equal(restoredLease?.state, 'acquired');

  const rollbackAcquire = rpc('runtime.capability.acquire', {
    slotId: rollbackSlotId,
    capabilityId: 'proof-resource',
    ownerRunId: rollbackRunId,
    proofRequirement: {
      capabilityId: 'proof-resource',
      reason: 'rolled-back eval proof',
      mode: 'state',
    },
  });
  assert.equal(rollbackAcquire.ok, true, JSON.stringify(rollbackAcquire));
  const rollbackRelease = rpc('runtime.capability.release', {
    slotId: rollbackSlotId,
    ownerRunId: rollbackRunId,
    capabilityId: 'proof-resource',
    keepWarm: false,
  });
  assert.equal(rollbackRelease.ok, true, JSON.stringify(rollbackRelease));
  // Reclaiming an unowned historical slot uses the release rollback path.
  // Its terminal posture must remain open so another attempt can acquire proof.
  const freeRollback = denied(
    { runId: freeRollbackRunId, stepName: 'prepare' },
    /Injected replay failure after claim/,
  );
  assert.equal(freeRollback.slotId, null);
  const freedSlot = rpc('fleet.status', {}).fleet.slots.find(
    (candidate) => candidate.slot === freeRollbackSlotId,
  );
  assert.equal(freedSlot?.currentRunId, null);
  const freeCapabilityStore = JSON.parse(readFileSync(env.FARMSLOT_CAPABILITY_STORE_FILE, 'utf8'));
  assert.equal(
    (freeCapabilityStore.terminalOwnerEntries ?? []).some(({ id }) => id === freeRollbackRunId),
    false,
  );
  const freeAcquire = rpc('runtime.capability.acquire', {
    slotId: freeRollbackSlotId,
    capabilityId: 'proof-resource',
    ownerRunId: freeRollbackRunId,
    proofRequirement: {
      capabilityId: 'proof-resource',
      reason: 'released rollback proof',
      mode: 'state',
    },
  });
  assert.equal(freeAcquire.ok, true, JSON.stringify(freeAcquire));
  const freeRelease = rpc('runtime.capability.release', {
    slotId: freeRollbackSlotId,
    ownerRunId: freeRollbackRunId,
    capabilityId: 'proof-resource',
    keepWarm: false,
  });
  assert.equal(freeRelease.ok, true, JSON.stringify(freeRelease));
  const parkedRepo = path.join(root, 'repo-parked');
  renameSync(repo, parkedRepo);
  symlinkSync(root, repo, 'dir');
  try {
    const rollbackFailure = denied(
      { runId: rollbackFailureRunId, stepName: 'prepare' },
      /Injected replay failure after claim.*rollback of reclaimed slot.*failed.*Refusing to release slot/s,
    );
    assert.equal(rollbackFailure.slotId, freeRollbackSlotId);
    const failedRollbackRow = JSON.parse(
      readFileSync(path.join(root, '.farm-status.json'), 'utf8'),
    ).slots.find((candidate) => candidate.slot === freeRollbackSlotId);
    assert.equal(failedRollbackRow?.current_run_id, rollbackFailureRunId);
  } finally {
    unlinkSync(repo);
    renameSync(parkedRepo, repo);
  }
  const blocked = denied({ runId, stepName: 'monitor' }, /No proof plan is recorded/);
  assert.equal(blocked.slotId, slotId);

  const beforeRestart = rpc('runtime.capability.acquire', {
    slotId,
    capabilityId: 'proof-resource',
    ownerRunId: runId,
    proofRequirement: {
      capabilityId: 'proof-resource',
      reason: 'held blocked proof before find-slot restart',
      mode: 'state',
    },
  });
  assert.equal(beforeRestart.ok, true, JSON.stringify(beforeRestart));
  const heldBeforeRestart = rpc('runtime.capability.status', {
    slotId,
    ownerRunId: runId,
  }).leases.find((lease) => lease.capabilityId === 'proof-resource');
  assert.equal(heldBeforeRestart?.state, 'acquired');
  const dependentBeforeRestart = rpc('runtime.capability.acquire', {
    slotId,
    capabilityId: 'proof-dependent',
    ownerRunId: runId,
    proofRequirement: {
      capabilityId: 'proof-dependent',
      reason: 'dependent proof before find-slot restart',
      mode: 'state',
    },
  });
  assert.equal(dependentBeforeRestart.ok, true, JSON.stringify(dependentBeforeRestart));
  const dependentLeaseId = dependentBeforeRestart.lease.id;
  rpc('run.replayStep', { runId, stepName: 'find-slot', triggeredBy: 'operator' });
  const restarted = rpc('run.get', { runId }).run;
  const slot = rpc('fleet.status', {}).fleet.slots.find((candidate) => candidate.slot === slotId);
  assert.equal(restarted.status, 'slot-finding');
  assert.equal(restarted.slotId, null);
  const afterRestart = rpc('runtime.capability.status', { slotId, ownerRunId: runId });
  // Released leases remain in the audit log (and may retain a warm provider).
  // They must no longer hold a claim after the slot is freed for another run.
  assert.equal(
    afterRestart.leases.find((lease) => lease.id === heldBeforeRestart.id)?.state,
    'released',
  );
  assert.equal(
    afterRestart.leases.find((lease) => lease.id === dependentLeaseId)?.state,
    'released',
  );
  assert.deepEqual(
    afterRestart.events
      .filter(
        (event) =>
          event.kind === 'released' &&
          [dependentLeaseId, heldBeforeRestart.id].includes(event.leaseId),
      )
      .map((event) => event.capabilityId),
    ['proof-dependent', 'proof-resource'],
  );

  const capabilityStore = JSON.parse(readFileSync(env.FARMSLOT_CAPABILITY_STORE_FILE, 'utf8'));
  assert.equal(
    (capabilityStore.terminalOwnerEntries ?? []).some(({ id }) => id === runId),
    false,
  );
  assert.equal(slot?.currentRunId, null);
  assert.equal(slot?.lifecycle, 'ready');
  assert.equal(restarted.steps.find((step) => step.name === 'find-slot').status, 'pending');
  const restartAcquire = rpc('runtime.capability.acquire', {
    slotId,
    capabilityId: 'proof-resource',
    ownerRunId: runId,
    proofRequirement: {
      capabilityId: 'proof-resource',
      reason: 'restarted worker proof',
      mode: 'state',
    },
  });
  assert.equal(restartAcquire.ok, true, JSON.stringify(restartAcquire));
  const reacquiredLease = rpc('runtime.capability.status', {
    slotId,
    ownerRunId: runId,
  }).leases.find((lease) => lease.owner.runId === runId && lease.state === 'acquired');
  assert.ok(reacquiredLease);
  assert.notEqual(reacquiredLease.id, heldBeforeRestart.id);
  const restartRelease = rpc('runtime.capability.release', {
    slotId,
    ownerRunId: runId,
    capabilityId: 'proof-resource',
    keepWarm: false,
  });
  assert.equal(restartRelease.ok, true, JSON.stringify(restartRelease));
  await stopGateway();
  writeJson(
    path.join(root, '.runs', `${successRunId}.json`),
    blockedRun(
      successRunId,
      slotId,
      'fix-bug',
      true,
      new Date(Date.parse(blockedAt) - 2000).toISOString(),
    ),
  );
  writeJson(path.join(root, '.farm-status.json'), {
    checked_at: new Date().toISOString(),
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
  const releasedProof = rpc('runtime.capability.release', {
    slotId,
    ownerRunId: successRunId,
    capabilityId: 'proof-resource',
    keepWarm: false,
  });
  assert.equal(releasedProof.ok, true, JSON.stringify(releasedProof));
  denied({ runId: successRunId, stepName: 'monitor' }, /Proof resources are not healthy/);
  const reacquiredProof = rpc('runtime.capability.acquire', {
    slotId,
    capabilityId: 'proof-resource',
    ownerRunId: successRunId,
    proofRequirement: {
      capabilityId: 'proof-resource',
      reason: 'blocked worker proof',
      mode: 'state',
    },
  });
  assert.equal(reacquiredProof.ok, true, JSON.stringify(reacquiredProof));

  writeJson(signalFile, {
    status: 'complete',
    outcome: 'success',
    attemptId: 'obsolete-attempt',
    timestamp: new Date(Date.parse(startedAt) - 1000).toISOString(),
  });
  const staleSignal = rpc('run.probeWorkerSignal', { runId: successRunId });
  assert.equal(staleSignal.code, 'stale', JSON.stringify(staleSignal));
  denied({ runId: successRunId, stepName: 'monitor' }, /older than this run/);

  // A fresh attempt timestamped between the blocked signal and the gateway's
  // monitor completion must reach artifact validation, even with worker clock skew.
  writeJson(signalFile, {
    status: 'complete',
    outcome: 'success',
    attemptId: randomUUID(),
    timestamp: new Date(Date.parse(blockedAt) - 1000).toISOString(),
  });
  const skewed = rpc('run.probeWorkerSignal', { runId: successRunId });
  assert.equal(skewed.code, 'artifact_contract', JSON.stringify(skewed));
  assert.match(skewed.message, /acceptance-status.json|AC-1/);
  denied({ runId: successRunId, stepName: 'monitor' }, /acceptance-status.json|AC-1/);

  const nextAttempt = randomUUID();
  writeJson(signalFile, {
    status: 'running',
    attemptId: 'blocked-attempt',
    timestamp: new Date().toISOString(),
  });
  denied({ runId: successRunId, stepName: 'monitor' }, /Start a new attempt with \.\/mark start/);
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
      lostEvalRunId,
      evalRunId,
      rollbackRunId,
      freeRollbackRunId,
      rollbackFailureRunId,
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
  if (rollbackWorkerSession) execFileSync('tmux', ['kill-session', '-t', rollbackSlotId]);
  if (logFd !== undefined) closeSync(logFd);
  rmSync(temporaryRoot, { recursive: true, force: true });
}
