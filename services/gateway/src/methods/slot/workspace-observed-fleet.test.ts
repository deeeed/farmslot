import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import { slotRecoveryEligibility } from '@farmslot/protocol';

import type { WorkspaceProbe } from './workspace-probe.js';

// Cached fleet reads answer from completed workspace observations without waiting for probes
// (#1529), learn of each changed observation as a slot change, and show a failed inspection's
// last verified workspace marked unverified.
const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-observed-fleet-'));
const repo = path.join(root, 'repo');
for (const name of [
  'pool',
  'projects/proof',
  'repo',
  'services/gateway',
  'scripts',
  'home',
  'runs',
])
  await mkdir(path.join(root, name), { recursive: true });
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
after(() => rm(root, { recursive: true, force: true }));
// Real Git metadata, so an unchanged repository is recognized by its workspace version.
execFileSync('git', ['init', '--quiet', repo]);
await writeFile(path.join(root, 'CLAUDE.md'), '# Observed fleet fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({ name: 'proof', default_branch: 'main' }),
);
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'fixture',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    platform: 'cli',
    project: 'proof',
    slots: [{ id: 'observed-slot', repo, session: 'observed-slot' }],
  }),
);
await writeFile(
  path.join(root, 'status.json'),
  JSON.stringify({
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: 'observed-slot',
        machine: 'fixture',
        platform: 'cli',
        project: 'proof',
        ssh: 'LOCAL',
        branch: 'main',
        head_sha: 'a'.repeat(40),
        agent: 'idle',
        enabled: true,
        dispatchable: true,
        lifecycle: 'ready',
        phase: null,
        slot_epoch: 1,
        current_run_id: null,
      },
    ],
  }),
);
await import('../../runtime/mock-pty.test-support.js');
const probe: WorkspaceProbe = {
  branch: 'main',
  headSha: 'a'.repeat(40),
  dirtyFingerprint: 'b'.repeat(64),
  dirtyCount: 1,
  localDefaultSha: 'a'.repeat(40),
  behind: 0,
  defaultFetchedAt: null,
  originKey: 'fixture',
  publicationRemote: 'origin',
  publicationRef: 'refs/heads/main',
};
let probes = 0;
let failProbe = false;
mock.module('../../core/read-probes.js', {
  namedExports: {
    readSlotProbe: async () => ({
      exitCode: 0,
      stdout: `${'a'.repeat(40)}\trefs/heads/main\n`,
      stderr: '',
    }),
  },
});
let pausedProbe: Promise<void> | undefined;
mock.module('./workspace-probe.js', {
  namedExports: {
    probeWorkspace: async () => {
      probes++;
      if (pausedProbe) await pausedProbe;
      if (failProbe) throw new Error('Workspace probe failed');
      return { ...probe };
    },
  },
});
const { loadFleetStatus } = await import('../../fleet/state.js');
const { resourceRevisions } = await import('../../resources/revisions.js');
const { observedFleetStatus } = await import('../fleet.js');
const { invalidateSlotWorkspaceObservations } = await import('./workspace.js');
const slotKey = { family: 'slot', slotId: 'observed-slot' } as const;
const observedRead = async () =>
  observedFleetStatus(await loadFleetStatus(false, true)).fleet.slots[0];
/** The background refresh reports through the slot revision. */
async function slotChangedAfter(revision: number): Promise<void> {
  for (let i = 0; i < 200 && resourceRevisions.revision(slotKey) === revision; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(resourceRevisions.revision(slotKey) > revision, 'the observation is a slot change');
  // Let the refresh finish publishing before the caller samples revisions again.
  await settle();
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('a cached fleet read answers before probes, and an unchanged repeat publishes nothing', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await loadFleetStatus(false, true);
  let release: () => void = () => assert.fail('Probe gate missing');
  pausedProbe = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = resourceRevisions.revision(slotKey);
  const cold = await observedRead();
  assert.equal(cold?.workspace, undefined, 'the read does not wait for the probe');
  release();
  pausedProbe = undefined;
  await slotChangedAfter(before);
  const published = resourceRevisions.revision(slotKey);
  const first = await observedRead();
  assert.equal(first?.workspace?.dirtyCount, 1);
  // Inside the inspection cache, then past it with unchanged Git metadata.
  for (const elapsed of [0, 16_000]) {
    now += elapsed;
    const again = await observedRead();
    await settle();
    assert.equal(again?.workspace?.observedAt, first?.workspace?.observedAt);
  }
  assert.equal(probes, 1, 'unchanged Git metadata reuses the inspection');
  assert.equal(resourceRevisions.revision(slotKey), published, 'a repeat read publishes nothing');
});

test('a failed inspection shows the workspace its row verifies, unverified; an invalidated one is gone', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  invalidateSlotWorkspaceObservations('observed-slot');
  let revision = resourceRevisions.revision(slotKey);
  await observedRead();
  await slotChangedAfter(revision);
  const kept = (await observedRead())?.workspace;
  assert.ok(kept);
  assert.equal(kept.publication, 'baseline');
  await settle();
  failProbe = true;
  t.after(() => {
    failProbe = false;
  });
  // Changed Git metadata and an expired cache make the background inspection run, and fail.
  const touched = new Date(2001, 0, 1);
  await utimes(path.join(repo, '.git/config'), touched, touched);
  now += 16_000;
  revision = resourceRevisions.revision(slotKey);
  await observedRead();
  await slotChangedAfter(revision);
  const failed = await observedRead();
  assert.match(failed?.workspaceError ?? '', /Workspace probe failed/);
  assert.equal(failed?.workspace?.observedAt, kept.observedAt);
  assert.equal(failed?.workspace?.dirtyCount, kept.dirtyCount);
  // Visible but unverified: release waits for an inspection that succeeds, as on main.
  assert.equal(failed?.workspace?.publication, 'unknown');
  assert.equal(slotRecoveryEligibility(failed).allowed, false);
  // A verified mutation clears the observation; it must not come back as unverified.
  invalidateSlotWorkspaceObservations('observed-slot');
  const invalidated = await observedRead();
  assert.equal(invalidated?.workspace, undefined);
});
