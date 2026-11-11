import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { FleetStatus } from '@farmslot/protocol';

import type { BackgroundHost } from '../host-services/background/client.js';
import type {
  BackgroundOperation,
  BackgroundParams,
  BackgroundResult,
} from '../host-services/background/protocol.js';

// A fleet with one local machine and one remote one. The refresh must hand only the local
// machine to the background host and merge its rows with the remote rows as before.
const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-background-routing-'));
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
await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated background routing fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({ name: 'proof', default_branch: 'main' }),
);
const checkout = path.join(root, 'checkout');
await mkdir(checkout);
for (const args of [
  ['init', '-q', '-b', 'main'],
  ['commit', '-q', '--allow-empty', '-m', 'root'],
])
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: checkout,
    stdio: 'ignore',
  });
await writeFile(
  path.join(root, 'pool/a-local.json'),
  JSON.stringify({
    machine: os.hostname(),
    host: 'localhost',
    platform: 'cli',
    project: 'proof',
    slots: [{ id: 'local-slot', repo: checkout }],
  }),
);
// Disabled, so the remote machine needs no node to produce its row.
await writeFile(
  path.join(root, 'pool/b-remote.json'),
  JSON.stringify({
    machine: 'remote-box',
    host: 'remote-box.invalid',
    platform: 'cli',
    project: 'proof',
    slots: [{ id: 'remote-slot', repo: '/srv/checkout', enabled: false }],
  }),
);
await writeFile(path.join(root, 'status.json'), '{"slots":[]}\n');

await import('../runtime/mock-pty.test-support.js');
const requests: Array<{ operation: BackgroundOperation; params: unknown }> = [];
let hostActive = true;
let hostFailure: Error | undefined;
const client = await import('../host-services/background/client.js');
const fakeHost: BackgroundHost = {
  active: () => hostActive,
  async request<O extends BackgroundOperation>(operation: O, params: BackgroundParams<O>) {
    requests.push({ operation, params });
    if (hostFailure) throw hostFailure;
    // The child runs the same handler; running it here keeps the rows comparable.
    const { backgroundHandlers } = await import('../host-services/background/handlers.js');
    const handler: (params: BackgroundParams<O>) => Promise<BackgroundResult<O>> =
      backgroundHandlers[operation];
    return handler(params);
  },
  start() {},
  stop: async () => {},
  status: () => client.backgroundHost.status(),
};
mock.module('../host-services/background/client.js', {
  namedExports: { ...client, backgroundHost: fakeHost },
});
const workspace = await import('./slot/workspace.js');
mock.module('./slot/workspace.js', {
  namedExports: { ...workspace, enrichFleetWorkspaces: async (fleet: FleetStatus) => fleet },
});
const { fleetHealthRefresh } = await import('./fleet.js');

function rows(fleet: FleetStatus) {
  return fleet.slots.map(({ slot, branch, lifecycle, dispatchable }) => ({
    slot,
    branch,
    lifecycle,
    dispatchable,
  }));
}

test('a refresh probes the local machine in the background and merges remote rows', async () => {
  requests.length = 0;
  hostActive = true;
  const background = rows((await fleetHealthRefresh()).fleet);
  assert.deepEqual(
    requests.map(({ operation, params }) => ({
      operation,
      slots: (params as BackgroundParams<'fleet.probeMachine'>).entries.map(
        (entry) => entry.pool.slots[entry.slotIdx].id,
      ),
      ssh: (params as BackgroundParams<'fleet.probeMachine'>).ssh,
    })),
    [{ operation: 'fleet.probeMachine', slots: ['local-slot'], ssh: [['localhost', 'local']] }],
  );
  assert.equal(background.find((row) => row.slot === 'local-slot')?.branch, 'main');

  // Without the host the same refresh runs in-process and writes the same rows.
  requests.length = 0;
  hostActive = false;
  const inProcess = rows((await fleetHealthRefresh()).fleet);
  assert.deepEqual(requests, []);
  assert.deepEqual(inProcess, background);
});

test('a refresh fails, leaving the stored fleet unchanged, while the host is down', async () => {
  hostActive = true;
  hostFailure = new client.BackgroundUnavailableError(
    'The gateway background process is restarting',
  );
  after(() => {
    hostFailure = undefined;
  });
  const before = await readFile(path.join(root, 'status.json'), 'utf8');
  await assert.rejects(fleetHealthRefresh(), client.BackgroundUnavailableError);
  assert.equal(await readFile(path.join(root, 'status.json'), 'utf8'), before);
});
