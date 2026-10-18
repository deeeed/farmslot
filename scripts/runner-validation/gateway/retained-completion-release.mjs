// Disposable-gateway proof that a refused completion keeps its slot until a
// replay from the refused step or a named force discard (ADR-065 Amendment 6),
// and that a replay selecting a fresh slot never leaves the old one held.
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

import WebSocket from 'ws';

import { FLOW_STEPS } from '@farmslot/protocol';

import '../lib/no-inherited-git-location.mjs';

import { testGatewayIdentity } from '../../lib/test-gateway-identity.mjs';
import {
  closeTmuxSandbox,
  GIT_LOCATION_ENV,
  openTmuxSandbox,
  tmuxSandboxEnvironment,
} from '../../quality/run-tsx-tests.mjs';

const sourceRoot = process.cwd();
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'farmslot-retained-completion-'));
const root = path.join(temporaryRoot, 'root');
const repo = path.join(temporaryRoot, 'repo');
const heldRepo = path.join(temporaryRoot, 'held-repo');
const gateRepo = path.join(temporaryRoot, 'gate-repo');
const origin = path.join(temporaryRoot, 'origin.git');
const project = `retained-completion-${randomUUID()}`;
const slotId = `retained-completion-${randomUUID()}`;
const runId = randomUUID();
// A failed run whose worker shutdown was never confirmed: its slot stays held.
const heldSlotId = `held-${randomUUID()}`;
const heldRunId = randomUUID();
// A run waiting at its publication gate: its slot is gate-held.
const gateSlotId = `gate-${randomUUID()}`;
const gateRunId = randomUUID();
// A failed run whose slot lives on a machine that cannot be reached.
const offlineSlotId = `offline-${randomUUID()}`;
const offlineRunId = randomUUID();
const taskFile = path.join(repo, 'tasks', runId, 'TASK.md');
const statusFile = path.join(root, '.farm-status.json');
const tmuxDir = openTmuxSandbox();
// An inherited GIT_DIR or GIT_INDEX_FILE (a hook, a worktree shell) would point
// fixture git and the gateway at the operator's repository instead.
const baseEnv = { ...process.env };
for (const key of GIT_LOCATION_ENV) delete baseEnv[key];
let gateway;
let logFd;
let observer;

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function git(cwd, ...args) {
  execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, env: baseEnv, stdio: 'pipe' },
  );
}

// A second client that never calls slot.release; it records the run's updates.
async function watchRunUpdates(url, token, id) {
  const ws = new WebSocket(url);
  const updates = [];
  await new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () =>
      ws.send(
        JSON.stringify({
          type: 'req',
          id: 'auth',
          method: 'auth.connect',
          params: { clientKind: 'ui', clientName: 'retained-completion-observer', token },
        }),
      ),
    );
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data));
      if (frame.id === 'auth') {
        if (frame.ok) resolve();
        else reject(new Error('The observer client was refused'));
      } else if (frame.event === 'run.updated' && frame.payload?.run?.id === id) {
        updates.push(frame.payload.run);
      }
    });
  });
  return { updates, close: () => ws.close() };
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

const slotRow = (id = slotId) => {
  const row = JSON.parse(readFileSync(statusFile, 'utf8')).slots.find((s) => s.slot === id);
  return { lifecycle: row?.lifecycle, phase: row?.phase, owner: row?.current_run_id ?? null };
};

try {
  // The slot's checkout tracks a real origin, so the discard's idle reset can fetch.
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin], {
    env: baseEnv,
    stdio: 'pipe',
  });
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '--initial-branch=main');
  writeFileSync(path.join(repo, 'README.md'), 'Disposable retained-completion fixture\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-qm', 'fixture');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(temporaryRoot, 'clone', '-q', origin, heldRepo);
  git(temporaryRoot, 'clone', '-q', origin, gateRepo);
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable retained-completion fixture\n');
  writeFileSync(path.join(root, 'scripts', 'dev.sh'), '#!/bin/sh\n');
  git(root, 'init', '-q');
  git(root, 'commit', '--allow-empty', '-qm', 'fixture root');
  writeJson(path.join(root, 'services', 'gateway', 'package.json'), {
    name: 'fixture',
    version: '0.0.0',
  });
  writeJson(path.join(root, 'pool', 'retained.json'), {
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
        id: heldSlotId,
        project,
        platform: 'cli',
        repo: heldRepo,
        session: heldSlotId,
        enabled: true,
        mode: 'dispatch',
      },
      {
        id: gateSlotId,
        project,
        platform: 'cli',
        repo: gateRepo,
        session: gateSlotId,
        enabled: true,
        mode: 'dispatch',
      },
    ],
  });
  writeJson(path.join(root, 'pool', 'offline.json'), {
    machine: 'offline-node',
    host: 'offline-node.invalid',
    ssh_user: os.userInfo().username,
    os: 'darwin',
    slots: [
      {
        id: offlineSlotId,
        project,
        platform: 'cli',
        repo: path.join(temporaryRoot, 'offline-repo'),
        session: offlineSlotId,
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
  });
  // What a refused COMPLETE prerequisite leaves: failed, slot and checkout retained.
  const steps = FLOW_STEPS.dev;
  const completeIdx = steps.indexOf('complete');
  writeJson(path.join(root, '.runs', `${runId}.json`), {
    id: runId,
    project,
    ticketOrPr: 'PROJ-999997',
    flowType: 'dev',
    status: 'failed',
    error: 'A declared deterministic check has no current passing receipt.',
    slotId,
    taskFile,
    createdAt: new Date(Date.now() - 120000).toISOString(),
    updatedAt: new Date(Date.now() - 60000).toISOString(),
    completedAt: new Date(Date.now() - 60000).toISOString(),
    decisions: [],
    metrics: { nudgeCount: 0, outcome: 'partial', runner: 'scripted', model: null },
    steps: steps.map((name, i) =>
      i < completeIdx
        ? { name, status: 'done', ...(name === 'write-task' ? { outputs: { taskFile } } : {}) }
        : i === completeIdx
          ? { name, status: 'failed', outputs: { gatePrerequisiteRefusal: {} } }
          : { name, status: 'skipped' },
    ),
  });
  const monitorIdx = steps.indexOf('monitor');
  writeJson(path.join(root, '.runs', `${heldRunId}.json`), {
    id: heldRunId,
    project,
    ticketOrPr: 'PROJ-999996',
    flowType: 'dev',
    status: 'failed',
    error: 'Worker exited before signalling done.',
    slotId: heldSlotId,
    createdAt: new Date(Date.now() - 120000).toISOString(),
    updatedAt: new Date(Date.now() - 60000).toISOString(),
    completedAt: new Date(Date.now() - 60000).toISOString(),
    decisions: [],
    metrics: { nudgeCount: 0, outcome: 'failed', runner: 'scripted', model: null },
    steps: steps.map((name, i) => ({
      name,
      status: i < monitorIdx ? 'done' : i === monitorIdx ? 'failed' : 'pending',
    })),
  });
  writeJson(path.join(root, '.runs', `${offlineRunId}.json`), {
    id: offlineRunId,
    project,
    ticketOrPr: 'PROJ-999994',
    flowType: 'dev',
    status: 'failed',
    error: 'Worker exited before signalling done.',
    slotId: offlineSlotId,
    createdAt: new Date(Date.now() - 120000).toISOString(),
    updatedAt: new Date(Date.now() - 60000).toISOString(),
    completedAt: new Date(Date.now() - 60000).toISOString(),
    decisions: [],
    metrics: { nudgeCount: 0, outcome: 'failed', runner: 'scripted', model: null },
    steps: steps.map((name, i) => ({
      name,
      status: i < monitorIdx ? 'done' : i === monitorIdx ? 'failed' : 'pending',
    })),
  });
  writeJson(path.join(root, '.runs', `${gateRunId}.json`), {
    id: gateRunId,
    project,
    ticketOrPr: 'PROJ-999995',
    flowType: 'dev',
    mode: 'autonomous',
    status: 'human-gating',
    slotId: gateSlotId,
    engineState: { generation: 4 },
    createdAt: new Date(Date.now() - 120000).toISOString(),
    updatedAt: new Date(Date.now() - 60000).toISOString(),
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'scripted', model: null },
    steps: steps.map((name, i) =>
      i < completeIdx
        ? { name, status: 'done' }
        : name === 'complete'
          ? { name, status: 'done', outputs: { slotDisposition: 'gate-held' } }
          : name === 'human-gate'
            ? { name, status: 'running' }
            : { name, status: 'pending' },
    ),
  });
  mkdirSync(path.dirname(taskFile), { recursive: true });
  writeFileSync(taskFile, '# Disposable retained completion\n');
  writeJson(statusFile, {
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: slotId,
        lifecycle: 'held',
        phase: 'occupied',
        agent: 'idle',
        current_run_id: runId,
        slot_epoch: 3,
      },
      {
        slot: heldSlotId,
        lifecycle: 'held',
        phase: 'occupied',
        agent: 'idle',
        current_run_id: heldRunId,
        slot_epoch: 2,
      },
      {
        slot: gateSlotId,
        lifecycle: 'busy',
        phase: 'working',
        agent: 'idle',
        current_run_id: gateRunId,
        slot_epoch: 5,
      },
      {
        slot: offlineSlotId,
        lifecycle: 'held',
        phase: 'occupied',
        agent: 'idle',
        current_run_id: offlineRunId,
        slot_epoch: 6,
      },
    ],
  });

  const port = await freePort();
  const token = testGatewayIdentity(path.join(temporaryRoot, 'home'), `ws://127.0.0.1:${port}`);
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
      FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
      NODE_TEST_CONTEXT: '1',
      // A replay from the refused step then fails right after its claim.
      FARMSLOT_TEST_REPLAY_FAIL_AFTER_CLAIM_RUN_IDS: runId,
      FARMSLOT_DEMO_POOL: '0',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      FARMSLOT_GATEWAY_PROFILE: 'proof',
      FARMSLOT_GATEWAY_PASSWORD: '',
      FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
      FARMSLOT_RPC_TIMEOUT_MS: '25000',
      TSX_TSCONFIG_PATH: path.join(sourceRoot, 'services/gateway/tsconfig.json'),
    },
    tmuxDir,
  );
  const rpc = (method, params) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
        { cwd: sourceRoot, env, encoding: 'utf8', timeout: 40000, stdio: 'pipe' },
      ),
    );
  const retained = () => {
    const { run } = rpc('run.get', { runId });
    assert.equal(run.status, 'failed');
    assert.equal(run.slotId, slotId);
    assert.equal(run.steps.find((step) => step.name === 'complete').status, 'failed');
    assert.deepEqual(slotRow(), { lifecycle: 'held', phase: 'occupied', owner: runId });
    return run;
  };

  logFd = openSync(path.join(temporaryRoot, 'gateway.log'), 'w');
  gateway = spawn(process.execPath, ['--import', 'tsx', 'services/gateway/src/index.ts'], {
    cwd: sourceRoot,
    env,
    stdio: ['ignore', logFd, logFd],
  });
  for (let attempt = 0; ; attempt++) {
    if (gateway.exitCode !== null || gateway.signalCode !== null)
      throw new Error('Fixture gateway exited during startup');
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    if (attempt >= 450) throw new Error('Fixture gateway did not start');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const steps0 = retained().steps;

  // The worker's own bound release, then an unbound recycle: both refused, nothing fenced.
  const refusal = new RegExp(`retained by run ${runId}, whose completion prerequisite failed`);
  assert.throws(() => rpc('slot.release', { slotId, expectedRunId: runId }), refusal);
  assert.throws(() => rpc('slot.recycle', { slotId }), refusal);
  retained();

  // A retry past the refused step is refused before it touches the run.
  assert.throws(
    () => rpc('run.replayStep', { runId, stepName: 'human-gate', triggeredBy: 'operator' }),
    /replay from the refused step or earlier/,
  );
  assert.deepEqual(retained().steps, steps0, 'the refused COMPLETE is not normalized');

  // A fresh slot selection would abandon the retained claim: refused before it touches the run.
  assert.throws(
    () => rpc('run.replayStep', { runId, stepName: 'find-slot', triggeredBy: 'operator' }),
    /a fresh slot selection would abandon it/,
  );
  assert.deepEqual(retained().steps, steps0, 'find-slot leaves the retained run untouched');

  // A replay from the refused step that fails after its claim restores the retained claim.
  assert.throws(
    () => rpc('run.replayStep', { runId, stepName: 'complete', triggeredBy: 'operator' }),
    /Injected replay failure after claim/,
  );
  retained();

  // A force reset that does not name the run is not the discard.
  assert.throws(() => rpc('slot.release', { slotId, forceReset: true }), refusal);
  retained();

  // While it holds the slot, every active view counts the run.
  const listedActive = () =>
    rpc('run.list', { active: true }).runs.some((listed) => listed.id === runId);
  const familyActive = () => {
    const result = rpc('family.observability.get', { familyId: runId });
    return (result.snapshot ?? result).runs.find((summary) => summary.runId === runId)?.active;
  };
  assert.equal(listedActive(), true, 'the retained run is listed as active');
  assert.equal(familyActive(), true, 'the family view counts the retained run as active');
  observer = await watchRunUpdates(`ws://127.0.0.1:${port}`, token, runId);

  // The named force discard releases it and settles the run; archive is then reachable.
  const discarded = rpc('slot.release', { slotId, expectedRunId: runId, forceReset: true });
  assert.equal(discarded.released, true);
  assert.equal(slotRow().owner, null);
  const discardedRun = rpc('run.get', { runId }).run;
  assert.equal(discardedRun.slotId, null);
  assert.equal(listedActive(), false, 'the discarded run is settled');
  assert.equal(familyActive(), false, 'the family view no longer counts the discarded run');
  const refusedStep = discardedRun.steps.find((step) => step.name === 'complete');
  assert.ok(refusedStep.outputs.gatePrerequisiteRefusal, 'the refusal stays as history');
  assert.equal(typeof refusedStep.outputs.gatePrerequisiteDiscardedAt, 'string');
  // The release's own events go to its caller only; the discard reaches every client.
  const observedDiscard = () =>
    observer.updates.some(
      (run) =>
        run.steps.find((step) => step.name === 'complete')?.outputs?.gatePrerequisiteDiscardedAt,
    );
  for (let attempt = 0; !observedDiscard() && attempt < 50; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(observedDiscard(), true, 'another client receives the discarded run');
  assert.equal(rpc('run.archive', { runId }).ok, true);
  assert.equal(listedActive(), false, 'the archived run is not listed as active');

  // A gate-held run's release would be refused, so its replay is refused before
  // it cancels the gate driver: generation, status and slot are unchanged.
  assert.throws(
    () =>
      rpc('run.replayStep', { runId: gateRunId, stepName: 'find-slot', triggeredBy: 'operator' }),
    new RegExp(`gate-held for run ${gateRunId}`),
  );
  const gateRun = rpc('run.get', { runId: gateRunId }).run;
  assert.deepEqual(
    [gateRun.status, gateRun.engineState?.generation, gateRun.slotId],
    ['human-gating', 4, gateSlotId],
  );
  assert.deepEqual(slotRow(gateSlotId), { lifecycle: 'busy', phase: 'working', owner: gateRunId });

  // Any other run releases the slot it still holds before it selects a fresh one.
  assert.deepEqual(slotRow(heldSlotId), { lifecycle: 'held', phase: 'occupied', owner: heldRunId });
  const reselected = rpc('run.replayStep', {
    runId: heldRunId,
    stepName: 'find-slot',
    triggeredBy: 'operator',
  }).run;
  assert.equal(reselected.slotId, null);
  assert.equal(slotRow(heldSlotId).owner, null, 'the old slot no longer names the run');
  assert.notEqual(slotRow(heldSlotId).lifecycle, 'held');
  rpc('run.cancel', { runId: heldRunId });

  // Release must confirm the old worker stopped, so a slot on a machine that
  // cannot be reached stays held, and the refusal names the way out.
  assert.throws(
    () =>
      rpc('run.replayStep', {
        runId: offlineRunId,
        stepName: 'find-slot',
        triggeredBy: 'operator',
      }),
    new RegExp(
      `could not be released before restarting this run \\(.+\\)\\. If its machine is offline, bring it back first; then replay again, or discard the workspace through slot\\.release RPC with forceReset:true and expectedRunId:${offlineRunId}`,
    ),
  );
  assert.equal(rpc('run.get', { runId: offlineRunId }).run.slotId, offlineSlotId);
  assert.equal(slotRow(offlineSlotId).owner, offlineRunId, 'the offline slot still names its run');

  console.log(
    JSON.stringify({
      runId,
      boundReleaseRefused: true,
      recycleRefused: true,
      laterStepReplayRefused: true,
      failedReplayRestoredClaim: true,
      namedDiscardReleased: discarded.released,
      listedActiveWhileHeld: true,
      settledAfterDiscard: { runList: false, familyView: false },
      otherClientSawDiscard: true,
      archivedAfterDiscard: true,
      findSlotReplayRefused: true,
      gateHeldReplayRefusedBeforeMutation: true,
      reselectionReleasedHeldSlot: slotRow(heldSlotId),
      offlineReplayRefusalNamesExits: true,
    }),
  );
} catch (error) {
  if (logFd !== undefined)
    console.error(readFileSync(path.join(temporaryRoot, 'gateway.log'), 'utf8').slice(-4500));
  throw error;
} finally {
  observer?.close();
  if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
    const stopped = once(gateway, 'exit');
    gateway.kill('SIGTERM');
    await stopped;
  }
  if (logFd !== undefined) closeSync(logFd);
  closeTmuxSandbox(tmuxSandboxEnvironment(baseEnv, tmuxDir));
  rmSync(temporaryRoot, { recursive: true, force: true });
}
