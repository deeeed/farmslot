#!/usr/bin/env node
// Live, read-only GitHub proof. The private gateway uses the production CI monitor.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedIOSGatewayProfile } from './seed-ios-gateway-profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const phase = process.argv[2];
const proofDir =
  process.env.CI_CONTEXT_PROOF_DIR ?? path.join(os.tmpdir(), 'companion-ci-context-proof');
const statePath = path.join(proofDir, 'state.json');
const project = 'ci-context-proof';
const simulator = process.env.IOS_SIMULATOR ?? process.env.SIMULATOR;
const bundle = process.env.FARMSLOT_RECIPE_APP_ID ?? 'net.siteed.farmslot.development';
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
};
const state = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const evidence = (name, value) =>
  write(path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR ?? proofDir, `${name}.json`), value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(read, timeout = 60_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('CI proof condition timed out');
}
function stop() {
  if (!fs.existsSync(statePath)) return;
  try {
    process.kill(-state().pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
function rpc(method, params = {}) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(root, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FARMSLOT_GATEWAY: `ws://127.0.0.1:${state().port}`,
          FARMSLOT_RPC_TIMEOUT_MS: '45000',
        },
      },
    ),
  );
}
function gate() {
  return rpc('run.get', { runId: state().runId }).run.decisions.find(
    (d) => d.id === state().decisionId,
  );
}
function open(legacy = false) {
  const s = state();
  execFileSync('xcrun', [
    'simctl',
    'openurl',
    simulator,
    `farmslot-development://workspace/decision/${legacy ? s.legacyId : s.decisionId}?runId=${legacy ? s.legacyRunId : s.runId}`,
  ]);
}

if (phase === 'serve') {
  await import(path.join(root, 'services/gateway/src/index.ts'));
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${state().port}/health`)).ok;
    } catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') return false;
      throw error;
    }
  });
  const { createRun, updateRun, getRun, persistRunNow } = await import(
    path.join(root, 'services/gateway/src/runs/store.ts')
  );
  const { monitorCI } = await import(path.join(root, 'services/gateway/src/ci-monitor/service.ts'));
  const s = state();
  const run = createRun({
    flowType: 'dev',
    mode: 'interactive',
    project,
    ticketOrPr: `CI-CONTEXT-${s.pr}`,
  });
  const taskDir = path.join(s.farm, 'projects', project, 'tasks', 'ci-context');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'TASK.md'), '# CI decision context proof\n');
  updateRun(run.id, {
    prNumber: s.pr,
    status: 'ci-watching',
    taskFile: path.join(taskDir, 'TASK.md'),
  });
  const legacy = createRun({
    flowType: 'dev',
    mode: 'interactive',
    project,
    ticketOrPr: 'CI-CONTEXT-LEGACY',
  });
  const legacyId = 'legacy-ci-context';
  updateRun(legacy.id, {
    status: 'blocked',
    prNumber: s.pr,
    taskFile: path.join(taskDir, 'TASK.md'),
    decisions: [
      {
        id: legacyId,
        type: 'ci_review_comments',
        title: 'Legacy CI decision',
        description: 'This historical gate did not record check metadata.',
        actions: [{ id: 'skip', label: 'Skip', style: 'secondary' }],
        createdAt: new Date().toISOString(),
      },
    ],
  });
  write(statePath, { ...s, runId: run.id, legacyRunId: legacy.id, legacyId });
  await persistRunNow(getRun(legacy.id));
  const monitoring = monitorCI(run.id, s.pr, s.repo, new AbortController().signal);
  monitoring.catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  const decision = await waitFor(() => getRun(run.id).decisions.find((d) => !d.resolvedAt));
  assert.equal(
    decision.type,
    'ci_ci_timeout',
    'Real monitor must raise a timeout, not another gate',
  );
  assert(decision.context?.checkSnapshot?.checks.length, 'Real GitHub checks must be recorded');
  write(statePath, { ...state(), decisionId: decision.id });
  await persistRunNow(getRun(run.id));
} else if (phase === 'setup') {
  stop();
  const repo = process.env.CI_CONTEXT_PROOF_REPO;
  const pr = Number(process.env.CI_CONTEXT_PROOF_PR);
  assert(repo && pr > 0, 'Set CI_CONTEXT_PROOF_REPO and CI_CONTEXT_PROOF_PR to a real open PR');
  const farm = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-context-farm-'));
  execFileSync('git', ['clone', '--shared', '--no-checkout', root, farm], { stdio: 'pipe' });
  const port = Number(process.env.CI_CONTEXT_PROOF_GATEWAY_PORT ?? 18796);
  for (const name of ['scripts', 'services', 'packages'])
    fs.symlinkSync(path.join(root, name), path.join(farm, name));
  fs.writeFileSync(path.join(farm, 'CLAUDE.md'), '# Private CI proof gateway\n');
  fs.mkdirSync(path.join(farm, 'pool'));
  write(path.join(farm, 'projects', project, 'project.json'), {
    name: project,
    default_branch: 'main',
    ci: {
      repo,
      check_groups: [
        {
          name: 'unmatched-proof-group',
          match: 'CI_CONTEXT_NEVER_MATCHES',
          match_mode: 'exact',
          aggregate: 'all',
        },
      ],
    },
    ci_watch: {
      max_hold_min: 0.0001,
      poll_interval_s: 1,
      auto_dispatch: { merge_conflicts: false, bot_comments: false, test_failures: false },
    },
  });
  write(statePath, { farm, port, pr, repo });
  const log = fs.openSync(path.join(proofDir, 'gateway.log'), 'a', 0o600);
  const child = spawn(
    path.join(root, 'node_modules/.bin/tsx'),
    [fileURLToPath(import.meta.url), 'serve'],
    {
      cwd: root,
      detached: true,
      stdio: ['ignore', log, log],
      env: {
        ...process.env,
        CI_CONTEXT_PROOF_DIR: proofDir,
        FARMSLOT_ROOT: farm,
        FARMSLOT_HOME: path.join(farm, 'home'),
        FARMSLOT_PROJECTS_DIR: path.join(farm, 'projects'),
        FARMSLOT_POOL_DIR: path.join(farm, 'pool'),
        FARMSLOT_RUNS_DIR: path.join(farm, 'runs'),
        FARMSLOT_DISPATCH_QUEUE_FILE: path.join(farm, 'queue.json'),
        FARMSLOT_BACKLOG_FILE: path.join(farm, 'backlog.json'),
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PORT: String(port),
        FARMSLOT_GATEWAY_TOKEN: '',
        FARMSLOT_GATEWAY_PASSWORD: '',
        FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'legacy-env',
        FARMSLOT_DISABLE_ORCHESTRATION: '1',
        FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
      },
    },
  );
  fs.closeSync(log);
  child.unref();
  write(statePath, { ...state(), pid: child.pid });
  try {
    await waitFor(() => {
      if (child.exitCode !== null)
        throw new Error(`Private gateway exited ${child.exitCode}; inspect gateway.log`);
      return state().decisionId;
    }, 90_000);
    seedIOSGatewayProfile({
      simulator,
      bundleId: bundle,
      profile: {
        id: project,
        name: 'CI context proof',
        url: `ws://127.0.0.1:${port}`,
        kind: 'lan',
        authMode: 'none',
      },
    });
  } catch (error) {
    stop();
    throw error;
  }
  evidence('live-gate', gate());
} else if (phase === 'relaunch') {
  execFileSync('xcrun', [
    'simctl',
    'openurl',
    simulator,
    `farmslot-development://expo-development-client/?url=${encodeURIComponent(`http://127.0.0.1:${process.env.METRO_PORT}`)}`,
  ]);
} else if (phase === 'open') open();
else if (phase === 'open-legacy') open(true);
else if (phase === 'before') {
  const before = { decision: gate(), current: rpc('pr.status', { project, pr: state().pr }).pr };
  assert(!before.decision.resolvedAt);
  assert(before.current.checkSnapshot?.checks.length);
  write(path.join(proofDir, 'before.json'), before);
  evidence('before-refresh', before);
} else if (phase === 'after') {
  const before = JSON.parse(fs.readFileSync(path.join(proofDir, 'before.json'), 'utf8'));
  const after = { decision: gate(), current: rpc('pr.status', { project, pr: state().pr }).pr };
  assert.deepEqual(
    after.decision,
    before.decision,
    'Phone refresh must not alter or resolve the decision',
  );
  assert(
    Date.parse(after.current.checkSnapshot.fetchedAt) >
      Date.parse(before.current.checkSnapshot.fetchedAt),
    'Phone refresh must reload GitHub metadata',
  );
  assert(
    after.current.checkSnapshot.checks.every(
      (c) => c.name && c.status && 'conclusion' in c && 'timestamp' in c && 'detailsUrl' in c,
    ),
  );
  const listed = rpc('run.list', {})
    .runs.find((r) => r.id === state().runId)
    .decisions.find((d) => d.id === state().decisionId);
  assert.equal(listed.context.checkSnapshot, undefined);
  assert(listed.payloadTrimmed.includes('context.checkSnapshot'));
  evidence('after-refresh', after);
  evidence('list-projection', listed);
} else if (phase === 'stop') stop();
else throw new Error(`Unknown proof phase: ${phase}`);
