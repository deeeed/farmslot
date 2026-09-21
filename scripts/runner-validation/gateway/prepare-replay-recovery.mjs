// Live gateway proof using a disposable local project/slot and Git repositories.
// Run against the gateway serving this checkout. No worker is dispatched:
// the dependency hook deliberately exits 42 after the branch checks.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = process.cwd();
const id = `prepare-replay-proof-${process.pid}`;
const inventory = JSON.parse(
  execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { encoding: 'utf8' }),
);
const simulator = Object.values(inventory.devices)
  .flat()
  .find((device) => device.isAvailable);
assert.ok(simulator, 'At least one available iOS simulator is required; none will be booted');
const dir = mkdtempSync(path.join(os.tmpdir(), id));
const repo = path.join(dir, 'repo');
const origin = path.join(dir, 'origin.git');
const projectDir = path.join(root, 'projects', id);
const pool = path.join(root, 'pool', `${id}.json`);
const taskFile = path.join(projectDir, 'tasks', 'proof', 'TASK.md');
const rpc = (method, params) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(root, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      {
        env: {
          ...process.env,
          FARMSLOT_GATEWAY: process.env.FARMSLOT_GATEWAY || 'ws://localhost:7777',
          FARMSLOT_RPC_TIMEOUT_MS: '120000',
        },
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 130000,
      },
    ),
  );
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let runId;
const evidence = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const config = {
  machine: os.hostname(),
  host: 'localhost',
  ssh_user: os.userInfo().username,
  os: 'darwin',
  slots: [
    {
      id,
      project: id,
      platform: 'ios',
      repo,
      session: id,
      enabled: true,
      mode: 'dispatch',
      resources: {
        'ios-sim': { simulator: 'nonexistent-prepare-proof' },
        'dev-server': { port: 48977, metro_port: 48977 },
      },
    },
  ],
};
async function failed() {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const r = rpc('run.get', { runId }).run;
    if (r.status === 'failed') {
      const slot = rpc('fleet.status', {}).fleet.slots.find((s) => s.slot === id);
      if (slot?.lifecycle === 'ready' && !slot.current_run_id) return r;
    }
    if (r.decisions?.some((d) => d.status === 'pending')) throw Error(JSON.stringify(r.decisions));
    await pause(500);
  }
  throw Error('Run did not fail at expected proof boundary');
}
try {
  git('init', '--initial-branch=main', repo);
  git('init', '--bare', '--initial-branch=main', origin);
  writeFileSync(path.join(repo, 'README.md'), 'baseline\n');
  git('-C', repo, 'add', '.');
  git(
    '-C',
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'fixture',
  );
  git('-C', repo, 'remote', 'add', 'origin', origin);
  git('-C', repo, 'push', '-u', 'origin', 'main');
  mkdirSync(path.dirname(taskFile), { recursive: true });
  writeFileSync(taskFile, '# Prepare replay validation\nNo implementation work.\n');
  writeFileSync(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: id,
      type: 'monorepo',
      default_branch: 'main',
      primary_repo: repo,
      default_safety_tier: 'dangerous',
      prepare: { default: 'proof', profiles: { proof: { phases: ['git', 'deps'] } } },
      hooks: { post_merge_install: 'echo intentional-proof-stop >&2; exit 42' },
    }),
  );
  writeFileSync(pool, JSON.stringify(config));
  rpc('fleet.refresh', {});
  await pause(2500);
  const created = rpc('run.create', {
    flowType: 'dev',
    project: id,
    ticketOrPr: 'CWDTEST-999998',
    ticketData: {
      source: 'manual',
      title: 'Prepare replay validation',
      description: 'Disposable lifecycle proof',
      acceptanceCriteria: [],
      affectedArea: '',
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
    slotId: id,
    taskFile,
    branch: 'proof-work',
    runner: 'claude',
    model: 'sonnet',
    mode: 'validation',
    prepareProfile: 'proof',
  });
  runId = created.run.id;
  rpc('run.autoRecovery.stop', { runId });
  let r = await failed();
  assert.match(r.error, /Simulator .*not found/);
  assert.equal(r.engineState.prepareBranch.started, false);
  evidence.push({
    claim: 'early failure retains never-started branch intent',
    error: r.error,
    state: r.engineState.prepareBranch,
  });
  config.slots[0].resources['ios-sim'].simulator = simulator.udid;
  writeFileSync(pool, JSON.stringify(config));
  await pause(1500);
  rpc('run.replayStep', { runId, stepName: 'prepare' });
  r = await failed();
  assert.match(r.error, /exit 42/);
  assert.equal(git('-C', repo, 'branch', '--show-current'), 'proof-work');
  assert.equal(r.engineState.prepareBranch.started, true);
  const branchStep = r.steps
    .find((step) => step.name === 'prepare')
    .outputs.subSteps.find((step) => step.name === 'branch');
  assert.match(branchStep.detail, /Created proof-work after prepare failed before branch setup/);
  evidence.push({
    claim: 'early replay creates work branch and reaches deps',
    error: r.error,
    state: r.engineState.prepareBranch,
  });
  writeFileSync(path.join(repo, 'README.md'), 'committed work\n');
  git('-C', repo, 'add', 'README.md');
  git(
    '-C',
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'work',
  );
  writeFileSync(path.join(repo, 'README.md'), 'keep my dirty work\n');
  const head = git('-C', repo, 'rev-parse', 'HEAD');
  rpc('run.replayStep', { runId, stepName: 'prepare' });
  r = await failed();
  assert.match(r.error, /exit 42/);
  assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8'), 'keep my dirty work\n');
  assert.equal(git('-C', repo, 'rev-parse', 'HEAD'), head);
  evidence.push({ claim: 'replay preserves existing branch and dirty work', head });
  git('-C', repo, 'checkout', '-b', 'saved-work');
  git('-C', repo, 'branch', '-D', 'proof-work');
  rpc('run.replayStep', { runId, stepName: 'prepare' });
  r = await failed();
  assert.match(r.error, /Replay cannot preserve/);
  assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8'), 'keep my dirty work\n');
  evidence.push({ claim: 'previously started missing branch fails closed', error: r.error });
  console.log(JSON.stringify({ runId, evidence }, null, 2));
} finally {
  if (runId) {
    const r = rpc('run.get', { runId }).run;
    if (!['failed', 'completed', 'cancelled'].includes(r.status)) rpc('run.cancel', { runId });
    rpc('run.delete', { runId });
  }
  const probe = (() => {
    try {
      return (execFileSync('tmux', ['has-session', '-t', `=${id}`], { stdio: 'pipe' }), true);
    } catch (e) {
      if (e.status === 1) return false;
      throw e;
    }
  })();
  if (probe) execFileSync('tmux', ['kill-session', '-t', `=${id}`]);
  rmSync(pool, { force: true });
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}
