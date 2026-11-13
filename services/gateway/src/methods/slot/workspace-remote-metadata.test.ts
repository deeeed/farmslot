import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import type { WorkspaceProbe } from './workspace-probe.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-remote-metadata-'));
for (const dir of ['pool', 'projects/proof', 'services/gateway', 'scripts', 'home', 'runs'])
  await mkdir(path.join(root, dir), { recursive: true });
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
await writeFile(path.join(root, 'CLAUDE.md'), '# Metadata fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  '{"name":"proof","default_branch":"main"}',
);
const ids = ['remote-metadata-1', 'remote-metadata-2'];
const head = 'a'.repeat(40);
for (const id of ids) {
  const git = path.join(root, id, '.git');
  await mkdir(path.join(git, 'refs/heads'), { recursive: true });
  await writeFile(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(git, 'refs/heads/main'), head + '\n');
}
await writeFile(
  path.join(root, 'pool/remote.json'),
  JSON.stringify({
    machine: 'metadata-remote',
    host: 'remote.invalid',
    ssh_user: 'fixture',
    platform: 'cli',
    project: 'proof',
    slots: ids.map((id) => ({ id, repo: path.join(root, id), session: id })),
  }),
);
await writeFile(
  path.join(root, 'status.json'),
  JSON.stringify({
    checked_at: new Date().toISOString(),
    slots: ids.map((slot) => ({
      slot,
      machine: 'metadata-remote',
      platform: 'cli',
      project: 'proof',
      ssh: 'OK',
      branch: 'main',
      head_sha: head,
      agent: 'idle',
      enabled: true,
      lifecycle: 'ready',
      slot_epoch: 1,
    })),
  }),
);
const rpc = await import('../../fleet/node-rpc.js');
let deniedReads = 0;
mock.module('../../fleet/node-rpc.js', {
  namedExports: {
    ...rpc,
    sendNodeRequest: async () => {
      deniedReads++;
      throw new Error('Access to .git is not allowed');
    },
  },
});
const exec = await import('../../core/exec.js');
let batches = 0;
mock.module('../../core/read-probes.js', {
  namedExports: {
    readSlotProbe: async (_vars: unknown, command: string, scope: string) => {
      if (scope === 'workspace-metadata') {
        batches++;
        return exec.execLocal(command, { timeout: 1000 });
      }
      return { exitCode: 0, stdout: `${head}\trefs/heads/main\n`, stderr: '' };
    },
  },
});
let probes = 0;
const probe: WorkspaceProbe = {
  branch: 'main',
  headSha: head,
  dirtyFingerprint: 'clean',
  dirtyCount: 0,
  localDefaultSha: head,
  behind: 0,
  defaultFetchedAt: null,
  originKey: 'fixture',
  publicationRemote: 'origin',
  publicationRef: 'refs/heads/main',
  publicationRemoteKey: 'fixture',
};
mock.module('./workspace-probe.js', {
  namedExports: {
    probeWorkspace: async () => {
      probes++;
      return probe;
    },
  },
});
const { loadFleetStatus } = await import('../../fleet/state.js');
const { registerNode, unregisterByWs } = await import('../../fleet/machine-registry.js');
const {
  enrichFleetWorkspaces,
  inspectSlotWorkspace,
  invalidateSlotWorkspaceObservations,
  observeSlotWorkspaces,
} = await import('./workspace.js');

test('remote .git denial does not force unchanged slots through full probes every 15 seconds', async (t) => {
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const accepted = new Promise<WebSocket>((resolve) => server.once('connection', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const opened = once(client, 'open');
  const socket = await accepted;
  await opened;
  registerNode('metadata-remote', 1, socket);
  const pairs = [{ socket, client }];
  t.after(async () => {
    for (const pair of pairs) {
      unregisterByWs(pair.socket);
      pair.client.terminate();
      pair.socket.terminate();
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const fleet = await loadFleetStatus(false, true);
  const first = await enrichFleetWorkspaces(fleet);
  assert.equal(probes, 2);
  assert.ok(first.slots.every((slot) => slot.workspace?.publication === 'baseline'));
  t.mock.timers.tick(16000);
  const second = await enrichFleetWorkspaces(fleet);
  assert.equal(
    probes,
    2,
    'unchanged remote metadata must reuse the existing 90-second observation',
  );
  assert.deepEqual(
    second.slots.map((slot) => slot.workspace?.observedAt),
    first.slots.map((slot) => slot.workspace?.observedAt),
  );
  assert.equal(batches, 2, 'two slots share one metadata batch per node per interval');
  assert.equal(deniedReads, 0, 'general node filesystem access to .git remains unused');
  const repeated = await Promise.all([enrichFleetWorkspaces(fleet), enrichFleetWorkspaces(fleet)]);
  assert.equal(batches, 2, 'concurrent reads inside the interval join completed metadata');
  assert.equal(probes, 2);
  assert.ok(
    repeated.every((result) =>
      result.slots.every((slot) => slot.workspace?.publication === 'baseline'),
    ),
  );
  await writeFile(path.join(root, ids[0], '.git/index'), 'changed index');
  t.mock.timers.tick(16000);
  await enrichFleetWorkspaces(fleet);
  assert.equal(probes, 3, 'only the changed slot is inspected');
  const beforeInvalidation = batches;
  invalidateSlotWorkspaceObservations(ids[0]);
  await enrichFleetWorkspaces(fleet);
  assert.equal(probes, 4, 'explicit invalidation forces inspection inside the metadata interval');
  assert.equal(batches, beforeInvalidation);
  await inspectSlotWorkspace(ids[1], { network: false });
  assert.equal(probes, 5, 'acting inspection never uses passive metadata reuse');
  t.mock.timers.tick(90001);
  await enrichFleetWorkspaces(fleet);
  assert.equal(probes, 7, 'unchanged observations still expire at 90 seconds');
  const beforeSubset = batches;
  for (const slot of fleet.slots) {
    invalidateSlotWorkspaceObservations(slot.slot);
    await observeSlotWorkspaces([slot], fleet.slots);
  }
  assert.equal(batches, beforeSubset, 'selected-slot readers retain the full node inventory');
  const { withSlotCommandExecutor } = await import('../../core/exec-scope.js');
  const { passiveWorkspaceVersions } = await import('./workspace-metadata.js');
  const isolated = await withSlotCommandExecutor(
    async () => assert.fail('metadata must not execute inside an owner'),
    () => passiveWorkspaceVersions(fleet.slots),
  );
  assert.equal(isolated.size, 0);
  const acceptedReplacement = new Promise<WebSocket>((resolve) =>
    server.once('connection', resolve),
  );
  const replacementClient = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const replacementOpened = once(replacementClient, 'open');
  const replacement = await acceptedReplacement;
  await replacementOpened;
  registerNode('metadata-remote', 2, replacement);
  pairs.push({ socket: replacement, client: replacementClient });
  const beforeReplacement = batches;
  assert.equal((await passiveWorkspaceVersions(fleet.slots)).size, 2);
  assert.equal(
    batches,
    beforeReplacement + 1,
    'a replaced connection cannot reuse the old node batch',
  );
});
