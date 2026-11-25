// A pool slot with `enabled: false` is disabled whatever its `mode` says. A trial hold written as
// `{ mode: 'dispatch', enabled: false }` stayed dispatchable because the fleet check let the
// explicit mode win, so a proof run prepared the held slot.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { FleetStatus } from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-slot-mode-'));
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
await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated slot-mode fleet fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({ name: 'proof', default_branch: 'main' }),
);
const checkout = path.join(root, 'checkout');
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: os.hostname(),
    host: 'localhost',
    platform: 'cli',
    project: 'proof',
    slots: [
      { id: 'held-dispatch', repo: checkout, mode: 'dispatch', enabled: false },
      { id: 'held-custom', repo: checkout, mode: 'custom', enabled: false },
      { id: 'open-dispatch', repo: checkout, mode: 'dispatch', enabled: true },
    ],
  }),
);
await writeFile(
  path.join(root, 'status.json'),
  JSON.stringify({ checked_at: '2000-01-01T00:00:00Z', slots: [] }),
);
await import('../runtime/mock-pty.test-support.js');
const forbidden = () => {
  throw new Error('Unexpected workspace action in slot-mode fixture');
};
mock.module('./slot/workspace.js', {
  namedExports: {
    enrichFleetWorkspaces: async (fleet: FleetStatus) => fleet,
    observedFleetWorkspaces: (fleet: FleetStatus) => fleet,
    markFailedWorkspacesUnverified: forbidden,
    recoveryFromRow: forbidden,
    workspaceProtectedReason: forbidden,
    inspectSlotWorkspace: forbidden,
    invalidateSlotWorkspaceObservations: forbidden,
    observeSlotWorkspaces: forbidden,
  },
});
const { fleetRefresh } = await import('./fleet.js');

test('enabled: false disables a slot even when its pool entry names a mode', async () => {
  const { fleet } = await fleetRefresh();
  const row = (slot: string) => {
    const found = fleet.slots.find((candidate) => candidate.slot === slot);
    assert.ok(found, `${slot} is in the fleet`);
    return found;
  };
  for (const slot of ['held-dispatch', 'held-custom']) {
    assert.equal(row(slot).lifecycle, 'disabled', `${slot} lifecycle`);
    assert.equal(row(slot).enabled, false, `${slot} enabled`);
    assert.equal(row(slot).dispatchable, false, `${slot} dispatchable`);
  }
  assert.notEqual(row('open-dispatch').lifecycle, 'disabled', 'an enabled slot is not disabled');
  assert.equal(row('open-dispatch').enabled, true);
});
