import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { Run, SlotStatus } from '@farmslot/protocol';

const root = mkdtempSync(path.join(tmpdir(), 'idle-holder-'));
for (const name of ['scripts', 'services/gateway', 'projects/farm', 'pool', 'home', 'runs', 'bin'])
  mkdirSync(path.join(root, name), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Isolated fixture\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
writeFileSync(
  path.join(root, 'projects/farm/project.json'),
  JSON.stringify({
    name: 'farm',
    repo_url: 'https://github.com/example/app.git',
    default_branch: 'main',
    ci: { repo: 'example/app' },
  }),
);
writeFileSync(path.join(root, 'bin/tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, '.farm-status.json'),
  NODE_TEST_CONTEXT: '1',
  PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH,
});
after(() => rmSync(root, { recursive: true, force: true }));

const {
  branchHolderGitCommand,
  branchHolderIsIdle,
  inspectReleasableBranchHolders,
  releaseBranchHolderForSelection,
} = await import('./branch-checkout.js');
const { slotBranchCheckoutBlocker } = await import('./slot-scoring.js');
const { loadFleetStatus, setCachedFleetForTests } = await import('../../fleet/state.js');
const branch = 'feature/qa';
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const base = path.join(root, 'base');
const holderRepo = path.join(root, 'holder');
const requestedRepo = path.join(root, 'requested');
mkdirSync(base);
git(base, 'init', '-b', 'main');
git(base, 'config', 'user.name', 'Fixture');
git(base, 'config', 'user.email', 'fixture@example.invalid');
git(base, 'config', 'commit.gpgsign', 'false');
writeFileSync(path.join(base, 'file.txt'), 'initial\n');
git(base, 'add', '.');
git(base, 'commit', '-m', 'test: seed');
git(base, 'branch', branch);
git(base, 'worktree', 'add', holderRepo, branch);
git(base, 'worktree', 'add', '--detach', requestedRepo, 'main');
const remote = path.join(root, 'remote.git');
execFileSync('git', ['clone', '--bare', base, remote], { stdio: 'ignore' });
git(base, 'remote', 'add', 'origin', remote);
git(base, 'fetch', 'origin');
writeFileSync(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'fixture',
    host: 'localhost',
    project: 'farm',
    platform: 'cli',
    slots: [
      { id: 'holder', repo: holderRepo, session: 'holder' },
      { id: 'requested', repo: requestedRepo, session: 'requested' },
    ],
  }),
);
const rows = ['holder', 'requested'].map((slot) => ({
  slot,
  machine: 'fixture',
  project: 'farm',
  platform: 'cli',
  linked_worktree: true,
  branch: slot === 'holder' ? branch : 'HEAD',
  head_sha: git(base, 'rev-parse', 'HEAD'),
  lifecycle: 'ready',
  phase: null,
  agent: 'idle',
  current_run_id: null as string | null,
  current_family_id: null,
  enabled: true,
  health: { ssh: 'LOCAL' },
}));
const writeStatus = () =>
  writeFileSync(
    path.join(root, '.farm-status.json'),
    JSON.stringify({ checked_at: new Date().toISOString(), slots: rows }),
  );
writeStatus();

test('idle holder classifier protects active, family and parked work, including archived records', () => {
  const slot = {
    slot: 'holder',
    lifecycle: 'ready',
    agent: 'idle',
    currentRunId: null,
    currentFamilyId: null,
  } as SlotStatus;
  assert.equal(branchHolderIsIdle(slot, []), true);
  for (const fields of [
    { currentRunId: 'run' },
    { currentFamilyId: 'family' },
    { lifecycle: 'busy' },
    { agent: 'working' },
  ])
    assert.equal(branchHolderIsIdle({ ...slot, ...fields } as SlotStatus, []), false);
  assert.equal(
    branchHolderIsIdle(slot, [{ id: 'run', slotId: 'holder', status: 'created' }]),
    false,
  );
  assert.equal(branchHolderIsIdle(slot, [{ id: 'run', slotId: 'holder', status: 'done' }]), true);
  const parked = {
    id: 'park',
    slotId: 'other',
    status: 'done',
    park: {
      slotId: 'holder',
      preservedWorkspace: { branch, headSha: git(base, 'rev-parse', 'HEAD') },
    },
  } as Run;
  assert.equal(branchHolderIsIdle(slot, [parked]), false);
});

test('branch conflicts stay on the same machine and preview exemptions require verified eligibility', () => {
  const requested = {
    slot: 'requested',
    project: 'farm',
    machine: 'fixture',
    linkedWorktree: true,
    branch: 'main',
  } as SlotStatus;
  const holder = { ...requested, slot: 'holder', branch };
  assert.equal(slotBranchCheckoutBlocker(requested, [requested, holder], branch), holder);
  assert.equal(
    slotBranchCheckoutBlocker(requested, [requested, holder], branch, new Set(['holder'])),
    null,
  );
  assert.equal(
    slotBranchCheckoutBlocker(requested, [requested, { ...holder, machine: 'another' }], branch),
    null,
  );
});

test('Git safety refuses tracked changes and unpushed commits while preserving untracked files', () => {
  const run = () =>
    spawnSync('bash', ['-c', branchHolderGitCommand(holderRepo, branch)], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  writeFileSync(path.join(holderRepo, 'file.txt'), 'dirty\n');
  assert.notEqual(run().status, 0);
  git(holderRepo, 'restore', 'file.txt');
  writeFileSync(path.join(holderRepo, 'file.txt'), 'ahead\n');
  git(holderRepo, 'commit', '-am', 'test: unpushed');
  assert.notEqual(run().status, 0);
  git(holderRepo, 'reset', '--hard', 'origin/' + branch);
  writeFileSync(path.join(holderRepo, 'untracked.txt'), 'keep\n');
  assert.equal(run().status, 0);
  assert.equal(readFileSync(path.join(holderRepo, 'untracked.txt'), 'utf8'), 'keep\n');
});

test('selection rejects a new owner and a dirty holder after preview and restores its fence', async () => {
  const fleet = await loadFleetStatus();
  setCachedFleetForTests(fleet);
  rows[0].current_run_id = 'new-owner';
  writeStatus();
  await assert.rejects(releaseBranchHolderForSelection('requested', branch), /idle, unowned/);
  assert.equal(git(holderRepo, 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
  rows[0].current_run_id = null;
  writeStatus();
  writeFileSync(path.join(holderRepo, 'file.txt'), 'changed after preview\n');
  await assert.rejects(releaseBranchHolderForSelection('requested', branch), /clean tracked files/);
  assert.equal(git(holderRepo, 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
  const row = JSON.parse(readFileSync(path.join(root, '.farm-status.json'), 'utf8')).slots[0];
  assert.equal(row.lifecycle, 'ready');
  assert.equal(row.phase, null);
  git(holderRepo, 'restore', 'file.txt');
  writeStatus();
});

test('production selection fences and detaches a clean pushed idle holder without moving its branch', async () => {
  const fleet = await loadFleetStatus();
  setCachedFleetForTests(fleet);
  const eligible = await inspectReleasableBranchHolders(fleet.slots, 'farm', branch);
  assert.ok(eligible.has('holder'));
  const sha = git(holderRepo, 'rev-parse', 'HEAD');
  await releaseBranchHolderForSelection('requested', branch);
  assert.equal(git(holderRepo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  assert.equal(git(base, 'rev-parse', branch), sha);
  assert.equal(readFileSync(path.join(holderRepo, 'untracked.txt'), 'utf8'), 'keep\n');
  const row = JSON.parse(readFileSync(path.join(root, '.farm-status.json'), 'utf8')).slots.find(
    (item: { slot: string }) => item.slot === 'holder',
  );
  assert.equal(row.lifecycle, 'ready');
  assert.equal(row.agent, 'idle');
  assert.equal(row.branch, 'HEAD');
  assert.equal(row.slot_epoch, 1);
  git(requestedRepo, 'checkout', branch);
  assert.equal(git(requestedRepo, 'rev-parse', 'HEAD'), sha);
});
