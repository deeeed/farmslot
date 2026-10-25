import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { WorkspaceProbe } from './workspace-probe.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-observation-cache-'));
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
await writeFile(path.join(root, 'CLAUDE.md'), '# Owned cache fixture\n');
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
    slots: [{ id: 'cache-slot', repo: path.join(root, 'repo'), session: 'cache-slot' }],
  }),
);
await writeFile(
  path.join(root, 'status.json'),
  JSON.stringify({
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: 'cache-slot',
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
let probes = 0;
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
mock.module('./workspace-probe.js', {
  namedExports: {
    probeWorkspace: async () => {
      probes++;
      return { ...probe };
    },
  },
});
mock.module('../../core/read-probes.js', {
  namedExports: {
    readSlotProbe: async () => ({
      exitCode: 0,
      stdout: `${'a'.repeat(40)}\trefs/heads/main\n`,
      stderr: '',
    }),
  },
});
const { loadFleetStatus } = await import('../../fleet/state.js');
const { enrichFleetWorkspaces, invalidateSlotWorkspaceObservations } =
  await import('./workspace.js');

test('observation timestamps do not turn unchanged status reads into repeated Git inspections', async () => {
  const first = await enrichFleetWorkspaces(await loadFleetStatus(true));
  assert.equal(first.slots[0]?.workspace?.dirtyCount, 1);
  await enrichFleetWorkspaces(await loadFleetStatus(true));
  assert.equal(probes, 1);
});

test('a verified mutation invalidates cached dirt before its TTL expires', async () => {
  probe.dirtyCount = 0;
  probe.dirtyFingerprint = 'c'.repeat(64);
  invalidateSlotWorkspaceObservations('cache-slot');
  const fresh = await enrichFleetWorkspaces(await loadFleetStatus(true));
  assert.equal(fresh.slots[0]?.workspace?.dirtyCount, 0);
  assert.equal(probes, 2);
});
