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

import { openSimulatorDevClient } from './simulator-dev-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const proofDir = path.join(root, 'temp/companion-backlog-review-proof');
const statePath = path.join(proofDir, 'state.json');
const seededId = 'saved-review-sequence-item';
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
  // A rerun can keep the token the Companion's saved proof profile already holds.
  const token = process.env.COMPANION_PROOF_TOKEN ?? randomBytes(32).toString('hex');
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
      id: seededId,
      project: 'companion-proof',
      title: 'Saved review sequence',
      sourceKind: 'manual',
      sourceRef: 'MANUAL-901',
      flowType: 'fix-bug',
      status: 'ready',
      priority: 10,
      reviewSequence: [{ runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', mode: 'cold' }],
      reviewSequenceContext: {
        reviewLineages: [
          { repository: 'validation/companion-proof', prNumber: 901, reviewId: 'proof-review-901' },
        ],
      },
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
      seeded = (await backlogItems()).find((item) => item.id === seededId);
    } catch (error) {
      // The owned gateway is still booting; any other failure repeats until the deadline.
      if (Date.now() + 1000 >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  assert.equal(seeded?.reviewSequence?.[0]?.mode, 'cold');
  fs.writeFileSync(path.join(proofDir, 'token'), token, { mode: 0o600 });
  evidence('backlog-before', { seeded });
  console.log(JSON.stringify({ gateway: `ws://127.0.0.1:${port}`, seededId }));
} else if (phase === 'relaunch' || phase === 'relaunch-connect') {
  // Start from a fresh app process so screens from an earlier step or attempt (an open manual
  // form, a still-mounted create sheet sharing test ids) cannot receive the next step's input.
  // The recipe waits for the tab bar before deep-linking. Relaunching reuses the installed dev client.
  assert(process.env.IOS_SIMULATOR, 'Set IOS_SIMULATOR to the leased simulator');
  const bundleId = process.env.BUNDLE_ID ?? 'net.siteed.farmslot.development';
  execFileSync('xcrun', ['simctl', 'terminate', process.env.IOS_SIMULATOR, bundleId]);
  await openSimulatorDevClient(process.env.IOS_SIMULATOR, {
    waitForBridge: phase !== 'relaunch-connect',
  });
} else if (phase === 'open-connection') {
  openUrl('/connection');
} else if (phase === 'open-create') {
  openUrl('/backlog/create');
} else if (phase === 'verify-refusal') {
  const items = await backlogItems();
  assert.equal(
    items.some((item) => item.title === createdTitle),
    false,
    'saving an unavailable WARM row must not create a COLD fallback item',
  );
  evidence('backlog-warm-refused', { created: false });
} else if (phase === 'verify-create') {
  const created = (await backlogItems())
    .filter((item) => item.title === createdTitle)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  evidence('backlog-created', created ?? null);
  assert(created, 'Companion create must persist the backlog item');
  assert.deepEqual(
    created.reviewSequence,
    [
      { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', mode: 'cold' },
      { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', mode: 'cold' },
    ],
    'Companion preserves ordered model and effort choices after explicit COLD recovery',
  );
  assert.equal(created.reviewSequenceContext, undefined, 'COLD rows carry no retained lineage');
} else if (phase === 'open-edit') {
  openUrl(`/backlog/edit/${seededId}`);
} else if (phase === 'verify-edit') {
  // Saving closes the edit screen, so the persisted item is the signal; the save is async.
  let repaired;
  for (let attempt = 0; attempt < 20; attempt++) {
    repaired = (await backlogItems()).find((item) => item.id === seededId);
    if (repaired?.reviewSequence?.[0]?.mode === 'warm') break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  evidence('backlog-after-edit', repaired ?? null);
  assert.deepEqual(
    repaired?.reviewSequence,
    [{ runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', mode: 'warm' }],
    'editing preserves the runner, model and effort while changing mode',
  );
  assert.deepEqual(
    repaired.reviewSequenceContext,
    {
      reviewLineages: [
        { repository: 'validation/companion-proof', prNumber: 901, reviewId: 'proof-review-901' },
      ],
    },
    'the saved WARM row preserves its configured lineage context',
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
