#!/usr/bin/env node
// Native proof for Companion backlog review rounds (ADR-058): a private fixture gateway holds a
// pre-migration backlog item whose review round still asks for full-live. The recipe drives the
// Companion UI; these phases only own the fixture gateway and read its persisted state.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const proofDir = path.join(root, 'temp/companion-backlog-review-proof');
const statePath = path.join(proofDir, 'state.json');
const legacyId = 'legacy-live-review-item';
const createdTitle = 'Companion static review round';
const phase = process.argv[2];

const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};
const evidence = (name, value) =>
  writeJson(
    path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR ?? proofDir, `${name}.json`),
    value,
  );

async function rpc(method, params = {}) {
  const state = readState();
  process.env.FARMSLOT_GATEWAY = `ws://127.0.0.1:${state.port}`;
  process.env.FARMSLOT_GATEWAY_TOKEN = state.token;
  const { rpc: call } = await import(
    path.join(root, 'scripts/runner-validation/scenarios/native-worker-lifecycle.mjs')
  );
  return call(method, params);
}
const backlogItems = async () => (await rpc('backlog.list', {})).items;
const openUrl = (route) => {
  assert(process.env.IOS_SIMULATOR, 'Set IOS_SIMULATOR to the leased simulator');
  execFileSync('xcrun', [
    'simctl',
    'openurl',
    process.env.IOS_SIMULATOR,
    `farmslot-development://${route}`,
  ]);
};

if (phase === 'setup') {
  assert(!fs.existsSync(statePath), `Run cleanup first; ${statePath} exists`);
  const fixture = path.join(proofDir, 'farm');
  const port = Number(process.env.COMPANION_PROOF_GATEWAY_PORT ?? 18791);
  const token = randomBytes(32).toString('hex');
  execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe' });
  for (const name of ['scripts', 'services', 'packages'])
    fs.symlinkSync(path.join(root, name), path.join(fixture, name));
  fs.writeFileSync(path.join(fixture, 'CLAUDE.md'), '# Companion backlog proof fixture\n');
  const project = path.join(fixture, 'projects/companion-proof');
  for (const flow of ['dev', 'fix-bug']) {
    fs.mkdirSync(path.join(project, 'shared', flow), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'shared', flow, 'shared.md'),
      `---\nplatforms: [cli]\n---\n\n# ${flow}\n\n- [ ] Perform the task.\n`,
    );
  }
  writeJson(path.join(project, 'project.json'), {
    name: 'companion-proof',
    default_branch: 'main',
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
    execution_templates: {
      sources: [{ id: 'workspace:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
    },
  });
  fs.mkdirSync(path.join(fixture, 'pool'));
  const seededAt = new Date().toISOString();
  writeJson(path.join(fixture, '.backlog.json'), [
    {
      id: legacyId,
      project: 'companion-proof',
      title: 'Legacy live review round',
      sourceKind: 'manual',
      sourceRef: 'MANUAL-901',
      flowType: 'fix-bug',
      status: 'ready',
      priority: 10,
      pendingReviewPlan: [{ order: 1, runner: 'codex', validationDepth: 'full-live' }],
      createdAt: seededAt,
      updatedAt: seededAt,
    },
  ]);
  const log = fs.openSync(path.join(proofDir, 'gateway.log'), 'a', 0o600);
  const gateway = spawn('yarn', ['workspace', '@farmslot/gateway', 'start'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      FARMSLOT_ROOT: fixture,
      FARMSLOT_HOME: path.join(fixture, 'home'),
      FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
      FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
      FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
      FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
      FARMSLOT_BACKLOG_FILE: path.join(fixture, '.backlog.json'),
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      FARMSLOT_GATEWAY_TOKEN: token,
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    },
  });
  gateway.unref();
  writeJson(statePath, { fixture, port, token, pid: gateway.pid });
  const deadline = Date.now() + 60000;
  let seeded;
  while (!seeded && Date.now() < deadline) {
    try {
      seeded = (await backlogItems()).find((item) => item.id === legacyId);
    } catch (error) {
      // The owned gateway is still booting; any other failure repeats until the deadline.
      if (Date.now() + 1000 >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  assert.equal(seeded?.pendingReviewPlan?.[0]?.validationDepth, 'full-live');
  fs.writeFileSync(path.join(proofDir, 'token'), token, { mode: 0o600 });
  evidence('backlog-before', { legacy: seeded });
  console.log(JSON.stringify({ gateway: `ws://127.0.0.1:${port}`, legacyId }));
} else if (phase === 'open-connection') {
  openUrl('/connection');
} else if (phase === 'open-create') {
  openUrl('/backlog/create');
} else if (phase === 'verify-create') {
  const created = (await backlogItems()).find((item) => item.title === createdTitle);
  evidence('backlog-created', created ?? null);
  assert(created, 'Companion create must persist the backlog item');
  assert.equal(created.pendingReviewPlan?.length, 1);
  assert.deepEqual(
    created.pendingReviewPlan.map((loop) => loop.validationDepth),
    ['static-code'],
    'a new Companion review round is static',
  );
} else if (phase === 'open-edit') {
  openUrl(`/backlog/edit/${legacyId}`);
} else if (phase === 'verify-edit') {
  const repaired = (await backlogItems()).find((item) => item.id === legacyId);
  evidence('backlog-after-edit', repaired ?? null);
  assert.deepEqual(
    repaired?.pendingReviewPlan?.map((loop) => [loop.runner, loop.validationDepth]),
    [['codex', 'static-code']],
    'saving a legacy round persists it as static with its runner',
  );
} else if (phase === 'cleanup') {
  if (fs.existsSync(statePath)) {
    const { pid } = readState();
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      // The owned process group already exited.
      if (error.code !== 'ESRCH') throw error;
    }
  }
  fs.rmSync(proofDir, { recursive: true, force: true });
} else {
  throw new Error(`Unknown phase ${phase}`);
}
