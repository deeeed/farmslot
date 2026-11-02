// Disposable-gateway proof that a closed or archived artifact-only validation run leaves its slot
// reusable (F291): its own unpushed branch commits are parked under a durable ref, recorded on the
// run with SHAs, the slot returns to idle and the same ticket's branch prepares again. Covers an
// archive after COMPLETE already released the slot (c9562e49), the named discard of a run held at a
// refused COMPLETE (29ce2ab4), the archive of a cancelled run, and a stacked commit that is not the
// run's own. Engine start is disabled; every release goes through the production RPCs.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
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
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'farmslot-validation-slot-'));
const root = path.join(temporaryRoot, 'root');
const origin = path.join(temporaryRoot, 'origin.git');
const project = `validation-slot-${randomUUID()}`;
// A test gateway reads slot rows only from an explicit status file outside its root.
const statusFile = path.join(temporaryRoot, 'status', 'farm-status.json');
const tmuxDir = openTmuxSandbox();
const baseEnv = { ...process.env };
for (const key of GIT_LOCATION_ENV) delete baseEnv[key];
let gateway;
let logFd;

const git = (cwd, ...args) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, env: baseEnv, encoding: 'utf8', stdio: 'pipe' },
  ).trim();
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
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

const steps = FLOW_STEPS.dev;
const completeIdx = steps.indexOf('complete');
/** One slot whose checkout holds a finished validation run's two unpushed commits. */
function seedSlot(name, ticket) {
  const id = `${name}-${randomUUID().slice(0, 8)}`;
  const repo = path.join(temporaryRoot, id);
  git(temporaryRoot, 'clone', '-q', origin, repo);
  const base = git(repo, 'rev-parse', 'HEAD');
  const branch = `${ticket}-validation`;
  git(repo, 'checkout', '-qb', branch);
  for (const n of [1, 2]) {
    writeFileSync(path.join(repo, `validation-${n}.txt`), `Validation output ${n}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', `validation ${n}`);
  }
  return {
    id,
    repo,
    base,
    branch,
    ticket,
    head: git(repo, 'rev-parse', 'HEAD'),
    runId: randomUUID(),
  };
}
function seedRun(slot, status, patch) {
  writeJson(path.join(root, '.runs', `${slot.runId}.json`), {
    id: slot.runId,
    project,
    ticketOrPr: slot.ticket,
    flowType: 'dev',
    mode: 'autonomous',
    lane: 'validation',
    completionPolicy: 'artifact-only',
    status,
    slotId: slot.id,
    branch: slot.branch,
    worktreeHeadAtDispatch: slot.base,
    createdAt: new Date(Date.now() - 120000).toISOString(),
    updatedAt: new Date(Date.now() - 60000).toISOString(),
    completedAt: new Date(Date.now() - 60000).toISOString(),
    decisions: [],
    metrics: { nudgeCount: 0, outcome: 'partial', runner: 'scripted', model: null },
    ...patch,
  });
}
const slotRow = (id) => {
  const row = JSON.parse(readFileSync(statusFile, 'utf8')).slots.find((s) => s.slot === id);
  return { lifecycle: row?.lifecycle, owner: row?.current_run_id ?? null };
};
/** The slot is back on main at origin, the run's branch is gone, and its commits are parked. */
function assertReturned(slot, run, label) {
  assert.equal(git(slot.repo, 'branch', '--show-current'), 'main', `${label}: slot on main`);
  assert.equal(git(slot.repo, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'main'), label);
  assert.equal(git(slot.repo, 'status', '--porcelain'), '', `${label}: clean`);
  assert.equal(git(slot.repo, 'branch', '--list', slot.branch), '', `${label}: branch dropped`);
  const ref = `refs/farmslot/parked/${slot.runId}/${slot.head}`;
  assert.equal(git(slot.repo, 'rev-parse', ref), slot.head, `${label}: parked ref keeps the head`);
  const parked = run.parkedCommits?.find((entry) => entry.ref === ref);
  assert.ok(parked, `${label}: the run records the parking`);
  assert.deepEqual(
    [parked.slotId, parked.branch, parked.baseSha, parked.headSha, parked.commits.length],
    [slot.id, slot.branch, slot.base, slot.head, 2],
    `${label}: the record names the slot, branch, base, head and both commits`,
  );
  return parked;
}

try {
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin], {
    env: baseEnv,
    stdio: 'pipe',
  });
  const seed = path.join(temporaryRoot, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '--initial-branch=main');
  writeFileSync(path.join(seed, 'README.md'), 'Disposable validation-slot fixture\n');
  writeFileSync(path.join(seed, '.gitignore'), 'tasks/\n.agent/\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'fixture');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', '-u', 'origin', 'main');

  // c9562e49: COMPLETE released the slot but kept the checkout; the run is done and unarchived.
  const released = seedSlot('released', 'TAT-9001');
  // 29ce2ab4: held at a refused COMPLETE; the operator discards the workspace by name.
  const held = seedSlot('held', 'TAT-9002');
  // A cancelled validation run that still owns its slot.
  const cancelled = seedSlot('cancelled', 'TAT-9003');
  // COMPLETE released this one too, but an operator then committed on top: not the run's own.
  const stacked = seedSlot('stacked', 'TAT-9004');
  const stackedRunHead = stacked.head;
  writeFileSync(path.join(stacked.repo, 'operator.txt'), 'Operator work\n');
  git(stacked.repo, 'add', '.');
  git(stacked.repo, 'commit', '-qm', 'operator work');
  stacked.head = git(stacked.repo, 'rev-parse', 'HEAD');
  // 2aecebfe: COMPLETE released the slot; closing the run's output retries its slot cleanup.
  const closed = seedSlot('closed', 'TAT-9005');
  // An interactive dev run the operator marks done without a PR: its release keeps the checkout.
  const interactive = seedSlot('interactive', 'TAT-9006');

  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable validation-slot fixture\n');
  writeFileSync(path.join(root, 'scripts', 'dev.sh'), '#!/bin/sh\n');
  // The project has no fixtures; the idle return still runs the gateway's fixture sync.
  writeFileSync(path.join(root, 'scripts', 'sync-fixtures.sh'), '#!/bin/sh\nexit 0\n');
  git(root, 'init', '-q');
  git(root, 'commit', '--allow-empty', '-qm', 'fixture root');
  writeJson(path.join(root, 'services', 'gateway', 'package.json'), {
    name: 'fixture',
    version: '0.0.0',
  });
  const slots = [released, held, cancelled, stacked, closed, interactive];
  writeJson(path.join(root, 'pool', 'validation.json'), {
    machine: os.hostname(),
    host: 'localhost',
    ssh_user: os.userInfo().username,
    os: process.platform,
    slots: slots.map((slot) => ({
      id: slot.id,
      project,
      platform: 'cli',
      repo: slot.repo,
      session: slot.id,
      enabled: true,
      mode: 'dispatch',
    })),
  });
  writeJson(path.join(root, 'projects', project, 'project.json'), {
    name: project,
    type: 'monorepo',
    primary_repo: released.repo,
    default_branch: 'main',
    task_dir: 'tasks',
    // Re-preparing the branch is the proof; dependencies and devices are out of scope.
    prepare: {
      default: 'git',
      compatibility_profile: 'git',
      profiles: { git: { label: 'Branch only', phases: ['git'] } },
    },
  });

  const doneSteps = steps.map((name) =>
    name === 'complete'
      ? { name, status: 'done', outputs: { slotDisposition: 'released' } }
      : { name, status: 'done' },
  );
  const releasedCheckout = (slot, headSha) => ({
    slotId: slot.id,
    branch: slot.branch,
    headSha,
    at: new Date(Date.now() - 90000).toISOString(),
  });
  seedRun(released, 'done', {
    steps: doneSteps,
    releasedCheckout: releasedCheckout(released, released.head),
  });
  // Held for a result decision at its refused COMPLETE: not terminal, so only the named discard parks.
  seedRun(held, 'needs-decision', {
    completedAt: undefined,
    error: 'A declared deterministic check has no current passing receipt.',
    steps: steps.map((name, i) =>
      i < completeIdx
        ? { name, status: 'done' }
        : i === completeIdx
          ? { name, status: 'failed', outputs: { gatePrerequisiteRefusal: {} } }
          : { name, status: 'skipped' },
    ),
  });
  seedRun(cancelled, 'cancelled', {
    steps: steps.map((name, i) => ({ name, status: i <= completeIdx ? 'done' : 'skipped' })),
  });
  seedRun(stacked, 'done', {
    steps: doneSteps,
    releasedCheckout: releasedCheckout(stacked, stackedRunHead),
  });
  const closeDecisionId = randomUUID();
  const closedAt = new Date(Date.now() - 30000).toISOString();
  seedRun(closed, 'done', {
    steps: doneSteps,
    releasedCheckout: releasedCheckout(closed, closed.head),
    output: { capturedAt: closedAt, closedAt, cleanupPending: true },
    decisions: [
      {
        id: closeDecisionId,
        type: 'engine_output_review',
        title: 'Review run output',
        description: 'Fixture output review',
        actions: [{ id: 'close-run', label: 'Close run' }],
        payload: { kind: 'output-review' },
        createdAt: closedAt,
        resolvedAt: closedAt,
        resolvedAction: 'close-run',
      },
    ],
  });
  seedRun(interactive, 'monitoring', {
    mode: 'interactive',
    completedAt: undefined,
    steps: steps.map((name) => ({
      name,
      status:
        steps.indexOf(name) < steps.indexOf('monitor')
          ? 'done'
          : name === 'monitor'
            ? 'running'
            : 'pending',
    })),
  });
  writeJson(statusFile, {
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: released.id,
        lifecycle: 'ready',
        phase: null,
        agent: 'idle',
        current_run_id: null,
        slot_epoch: 3,
      },
      {
        slot: held.id,
        lifecycle: 'held',
        phase: 'occupied',
        agent: 'idle',
        current_run_id: held.runId,
        slot_epoch: 3,
      },
      {
        slot: cancelled.id,
        lifecycle: 'held',
        phase: 'occupied',
        agent: 'idle',
        current_run_id: cancelled.runId,
        slot_epoch: 3,
      },
      {
        slot: stacked.id,
        lifecycle: 'ready',
        phase: null,
        agent: 'idle',
        current_run_id: null,
        slot_epoch: 3,
      },
      {
        slot: closed.id,
        lifecycle: 'ready',
        phase: null,
        agent: 'idle',
        current_run_id: null,
        slot_epoch: 3,
      },
      {
        slot: interactive.id,
        lifecycle: 'busy',
        phase: 'working',
        agent: 'idle',
        current_run_id: interactive.runId,
        slot_epoch: 3,
      },
    ],
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
      FARMSLOT_CAPABILITY_STORE_FILE: path.join(root, '.runs', 'runtime-capabilities.json'),
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
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
  /** A run read back from the live ledger or, once archived, from the archive on disk. */
  const storedRun = (runId) => {
    const live = path.join(root, '.runs', `${runId}.json`);
    if (existsSync(live)) return JSON.parse(readFileSync(live, 'utf8'));
    const archived = path.join(root, '.runs', 'archive', `${runId}.json`);
    if (existsSync(archived)) return JSON.parse(readFileSync(archived, 'utf8'));
    throw new Error(
      `Run ${runId} not found in ${readdirSync(path.join(root, '.runs')).join(', ')}`,
    );
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
  // Each scenario runs on its own slot and reports on its own, so a revert shows which step fails.
  const results = {};
  const scenario = (label, action) => {
    const started = Date.now();
    try {
      results[label] = { pass: true, detail: action(), ms: Date.now() - started };
    } catch (error) {
      results[label] = {
        pass: false,
        // A refused RPC's reason is on its stderr; an assertion's is its first line.
        detail: String(error.stderr ?? '').trim() || error.message.split('\n')[0],
        ms: Date.now() - started,
      };
    }
  };

  // 1. c9562e49: archiving the done run returns its released checkout to idle, commits parked;
  // the same ticket then prepares again on that slot, from main, with no unpushed-commit refusal.
  scenario('archive after COMPLETE released the slot', () => {
    assert.equal(git(released.repo, 'branch', '--show-current'), released.branch);
    assert.equal(rpc('run.archive', { runId: released.runId }).ok, true);
    const parked = assertReturned(released, storedRun(released.runId), 'archive');
    assert.equal(slotRow(released.id).owner, null);
    return parked;
  });
  scenario('the same ticket prepares again', () => {
    rpc('slot.prepare', { slotId: released.id, branch: released.branch, prepareProfile: 'git' });
    assert.equal(git(released.repo, 'branch', '--show-current'), released.branch);
    assert.equal(git(released.repo, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'main'));
    return 'fresh branch from main';
  });

  // 2. 29ce2ab4: the named discard of a run held at a refused COMPLETE parks before its reset.
  scenario('named discard of a run held at a refused COMPLETE', () => {
    const discarded = rpc('slot.release', {
      slotId: held.id,
      expectedRunId: held.runId,
      forceReset: true,
    });
    assert.equal(discarded.released, true);
    assertReturned(held, storedRun(held.runId), 'named discard');
    assert.equal(slotRow(held.id).owner, null);
    return 'parked';
  });

  // 3. Archiving a cancelled run that still owns its slot parks its commits and returns the slot.
  scenario('archive of a cancelled run that owns its slot', () => {
    assert.equal(rpc('run.archive', { runId: cancelled.runId }).ok, true);
    assertReturned(cancelled, storedRun(cancelled.runId), 'cancelled archive');
    assert.equal(slotRow(cancelled.id).owner, null);
    return 'parked';
  });

  // 4. A commit stacked after COMPLETE is not the run's: the archive leaves the checkout untouched.
  scenario('a commit stacked after COMPLETE is kept', () => {
    assert.equal(rpc('run.archive', { runId: stacked.runId }).ok, true);
    assert.equal(git(stacked.repo, 'branch', '--show-current'), stacked.branch);
    assert.equal(git(stacked.repo, 'rev-parse', 'HEAD'), stacked.head);
    assert.equal(git(stacked.repo, 'for-each-ref', 'refs/farmslot/'), '');
    const stackedRun = storedRun(stacked.runId);
    assert.equal(stackedRun.parkedCommits, undefined);
    assert.match(stackedRun.slotTeardownSkipped ?? '', /Checkout retained/);
    return stackedRun.slotTeardownSkipped;
  });

  // 5. 2aecebfe: closing the output retries cleanup through the done release, which returns the
  // checkout COMPLETE released (the slot has no owner) to idle.
  scenario('output close after COMPLETE released the slot', () => {
    rpc('run.resolveDecision', {
      runId: closed.runId,
      decisionId: closeDecisionId,
      actionId: 'close-run',
    });
    const run = storedRun(closed.runId);
    assertReturned(closed, run, 'output close');
    assert.equal(run.output?.cleanupPending, false);
    return 'parked';
  });

  // 6. Interactive done-no-pr releases the slot before the run is done: it records the head it
  // leaves, and the archive parks exactly that head.
  scenario('interactive done-no-pr, then archive', () => {
    rpc('run.interactiveDev.resolve', { runId: interactive.runId, action: 'done-no-pr' });
    const done = storedRun(interactive.runId);
    assert.equal(done.status, 'done');
    assert.deepEqual(
      [done.releasedCheckout?.slotId, done.releasedCheckout?.headSha],
      [interactive.id, interactive.head],
      'the release named the head it left',
    );
    assert.equal(git(interactive.repo, 'branch', '--show-current'), interactive.branch);
    assert.equal(rpc('run.archive', { runId: interactive.runId }).ok, true);
    assertReturned(interactive, storedRun(interactive.runId), 'interactive archive');
    return 'parked';
  });

  console.log(JSON.stringify(results, null, 2));
  assert.ok(
    Object.values(results).every((result) => result.pass),
    'every scenario passes',
  );
} catch (error) {
  if (logFd !== undefined)
    console.error(readFileSync(path.join(temporaryRoot, 'gateway.log'), 'utf8').slice(-6000));
  throw error;
} finally {
  if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
    const stopped = once(gateway, 'exit');
    gateway.kill('SIGTERM');
    const killer = setTimeout(() => gateway.kill('SIGKILL'), 10000);
    await stopped;
    clearTimeout(killer);
  }
  if (logFd !== undefined) closeSync(logFd);
  closeTmuxSandbox(tmuxSandboxEnvironment(baseEnv, tmuxDir));
  // FARMSLOT_PROOF_KEEP=1 keeps the fixture and gateway log for inspection.
  if (process.env.FARMSLOT_PROOF_KEEP === '1') console.error(`Kept ${temporaryRoot}`);
  else rmSync(temporaryRoot, { recursive: true, force: true });
}
