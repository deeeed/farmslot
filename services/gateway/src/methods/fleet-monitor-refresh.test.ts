import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { FleetStatus } from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-monitor-refresh-'));
for (const directory of ['pool', 'projects/proof', 'scripts', 'services/gateway', 'runs', 'home'])
  await mkdir(path.join(root, directory), { recursive: true });
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
after(() => rm(root, { recursive: true, force: true }));
await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated stale fleet fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({ name: 'proof', default_branch: 'main' }),
);
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: os.hostname(),
    host: 'localhost',
    platform: 'cli',
    project: 'proof',
    slots: [{ id: 'monitor-slot', repo: path.join(root, 'checkout'), enabled: false }],
  }),
);
await writeFile(
  path.join(root, 'status.json'),
  JSON.stringify({
    checked_at: '2000-01-01T00:00:00Z',
    slots: [
      {
        slot: 'monitor-slot',
        machine: os.hostname(),
        platform: 'cli',
        project: 'proof',
        enabled: false,
        ssh: 'LOCAL',
        lifecycle: 'disabled',
        agent: '-',
        dispatchable: false,
      },
    ],
  }),
);
await import('../runtime/mock-pty.test-support.js');
let workspaceRefreshes = 0;
const forbidden = () => {
  throw new Error('Unexpected workspace action in machine-refresh fixture');
};
mock.module('./slot/workspace.js', {
  namedExports: {
    enrichFleetWorkspaces: async (fleet: FleetStatus) => {
      workspaceRefreshes++;
      return fleet;
    },
    observedFleetWorkspaces: (fleet: FleetStatus) => fleet,
    markFailedWorkspacesUnverified: forbidden,
    recoveryFromRow: forbidden,
    workspaceProtectedReason: forbidden,
    inspectSlotWorkspace: forbidden,
    invalidateSlotWorkspaceObservations: forbidden,
    observeSlotWorkspaces: forbidden,
  },
});
const { fleetMonitorStatus, fleetRefresh, fleetHealthRefresh } = await import('./fleet.js');

test('a stale monitor refreshes real machine state without borrowing viewer enrichment', async () => {
  assert.equal((await fleetMonitorStatus()).fleet.stale, true);
  // Join the production coordinators with one explicit viewer refresh. Exactly
  // that viewer may enrich; the already requested monitor refresh may not.
  const result = await fleetRefresh();
  assert.equal(result.fleet.slots.length, 1);
  assert.equal(workspaceRefreshes, 1, 'The stale monitor also enriched workspace data');
  const saved = JSON.parse(await readFile(path.join(root, 'status.json'), 'utf8'));
  assert(Date.parse(saved.checked_at) > Date.parse('2000-01-01T00:00:00Z'));
});

test('startup and configuration refreshes use the shared health-only producer', async () => {
  const before = workspaceRefreshes;
  const result = await fleetHealthRefresh();
  assert.equal(result.fleet.slots.length, 1);
  assert.equal(workspaceRefreshes, before);
});
