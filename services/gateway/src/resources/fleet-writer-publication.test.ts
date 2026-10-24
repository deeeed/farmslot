// @farmslot:serial — isolated module graph owns its private root and revision publisher.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test, type TestContext } from 'node:test';

import { type ResourceKey, resourceKeyId } from '@farmslot/protocol/client-cache';
import type { ResourceChangedPayload } from '@farmslot/protocol/transport/events';

// Guard must precede all production imports, including transitive PTY imports.
import '../runtime/mock-pty.test-support.js';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fleet-writer-publication-')));
const statusPath = path.join(root, '.farm-status.json');
const overrides = {
  FARMSLOT_ROOT: root,
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_WORKSPACE: path.join(root, 'workspace'),
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_TEST_STATUS_FILE: statusPath,
  FARMSLOT_RESOURCE_WATCH_STATE_FILE: path.join(root, 'resource-watch.json'),
  FARMSLOT_RESOURCE_WATCHES: '0',
  FARMSLOT_FLEET_STALE_MS: '300000',
  NODE_TEST_CONTEXT: '1',
};
const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
Object.assign(process.env, overrides);
let disposeOwners: (() => void) | undefined;
after(async () => {
  // No startWatching/startResourcePolling call is made. Close finite publication/deadline
  // timers before removing the canonical root, even if a test assertion fails.
  try {
    disposeOwners?.();
    await rm(root, { recursive: true, force: true });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
for (const directory of ['scripts', 'services/gateway', 'pool', 'projects', 'workspace', 'home'])
  await mkdir(path.join(root, directory), { recursive: true });
// Actual slot-config discovery resolves only this private root.
await writeFile(path.join(root, 'CLAUDE.md'), 'private test root\n');
await writeFile(path.join(root, 'scripts/dev.sh'), '# private marker\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}\n');

const forbidden = (): never =>
  assert.fail('Execution/operator discovery outside private fleet fixture');
// Neither owner under test nor its publication helpers are mocked. Unrelated
// execution/discovery modules are replaced before import and cannot start a process.
mock.module('../fleet/node-health.js', {
  namedExports: {
    enrichSlotHostLoad: () => {},
    getAllMachineHealth: () => [],
  },
});
mock.module('../core/exec.js', { namedExports: { execLocal: forbidden } });
mock.module('../core/hooks.js', { namedExports: { expandTemplate: forbidden } });
mock.module('../core/project-env.js', { namedExports: { withProjectMachineEnv: forbidden } });
mock.module('../core/resource-lifecycle-log.js', {
  namedExports: { reportSlotResourceLifecycle: forbidden },
});
mock.module('../core/slot-io.js', {
  namedExports: { slotFileExists: forbidden, slotReadFile: forbidden },
});
mock.module('../core/tmux.js', { namedExports: { shellQuote: forbidden } });
mock.module('../node-support/remote-command.js', {
  namedExports: { resolveRemoteFarmCommand: forbidden },
});
mock.module('../fleet/device-inventory.js', { namedExports: { deviceControlVerdict: forbidden } });
mock.module('../fleet/machine-registry.js', {
  namedExports: { getAllNodes: () => [], getNode: forbidden },
});
mock.module('../fleet/node-rpc.js', {
  namedExports: { getSlotLocality: forbidden, sendNodeRequest: forbidden },
});
mock.module('../fleet/resource-exec.js', { namedExports: { execResourceCommand: forbidden } });
mock.module('../fleet/resource-process.js', { namedExports: { probeResourceProcess: forbidden } });

const core = await import('../core/state.js');
const fleet = await import('../fleet/state.js');
const resources = await import('../fleet/resource-manager.js');
const { resourceRevisions } = await import('./revisions.js');
disposeOwners = () => {
  resources.stopResourcePolling();
  resourceRevisions.dispose();
  resourceRevisions.setPublisher(() => {});
};
assert.equal(core.statusFile, statusPath, 'Never open the operator status file');

const slotId = 'owned-fleet-slot';
const otherId = 'unrelated-fleet-slot';
const project = 'owned-project';
const nodeId = 'owned-node';
const keys = (projectName = project, machine = nodeId): ResourceKey[] => [
  { family: 'slots', scope: 'farm' },
  { family: 'slot', slotId },
  { family: 'slots', scope: 'farm', project: projectName },
  { family: 'slots', scope: 'farm', nodeId: machine },
];
const ids = (values: readonly ResourceKey[]) => [...new Set(values.map(resourceKeyId))].sort();
let packets: ResourceChangedPayload[] = [];
let publishedStatus: string[] = [];
let sequence = 0;

async function flush(t: TestContext): Promise<void> {
  // Real publication code runs. Only its clock is advanced, including the worker
  // 200ms coalescer. No advance/publish/slot-owner helper is invoked by tests.
  await Promise.resolve();
  t.mock.timers.tick(201);
  await Promise.resolve();
}
async function fixture(t: TestContext): Promise<void> {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    disposeOwners?.();
    t.mock.timers.reset();
  });
  packets = [];
  resourceRevisions.setPublisher((packet) => {
    packets.push(packet);
    publishedStatus.push(readFileSync(statusPath, 'utf8'));
  });
  await writeFile(
    path.join(root, 'pool/owned.json'),
    JSON.stringify({
      machine: nodeId,
      host: 'localhost',
      project,
      slots: [{ id: slotId }, { id: otherId }],
    }),
  );
  await writeFile(
    statusPath,
    JSON.stringify({
      checked_at: new Date().toISOString(),
      slots: [
        {
          slot: slotId,
          machine: nodeId,
          project,
          enabled: true,
          lifecycle: 'ready',
          current_run_id: 'owned-run',
          branch: 'main',
          slot_epoch: 4,
        },
        {
          slot: otherId,
          machine: 'unrelated-node',
          project: 'unrelated-project',
          enabled: true,
          lifecycle: 'ready',
          current_run_id: null,
        },
      ],
    }),
  );
  await fleet.loadFleetStatus(true, true);
  await flush(t);
  packets = [];
}
async function expectWrite(
  t: TestContext,
  write: () => void | Promise<unknown>,
  expected: ResourceKey[],
  readable?: () => void | Promise<void>,
): Promise<void> {
  packets = [];
  publishedStatus = [];
  const before = resourceRevisions.revision({ family: 'slot', slotId: otherId });
  await write();
  // Check new facts before flushing the real publisher, not an injected result.
  await readable?.();
  await flush(t);
  const committed = await readFile(statusPath, 'utf8');
  for (const atPublication of publishedStatus)
    assert.equal(
      atPublication,
      committed,
      'Publication must follow the atomic rename, not expose former bytes',
    );
  assert.deepEqual(
    ids(packets.flatMap((packet) => packet.changes.map((change) => change.key))),
    ids(expected),
  );
  assert.equal(resourceRevisions.revision({ family: 'slot', slotId: otherId }), before);
  for (const packet of packets)
    for (const change of packet.changes)
      assert.equal(change.revision, resourceRevisions.revision(change.key));
}
async function expectQuiet(t: TestContext, write: () => void | Promise<unknown>): Promise<void> {
  const watched: ResourceKey[] = [
    ...keys(),
    { family: 'workers', scope: 'farm' },
    { family: 'runs', scope: 'farm' },
    { family: 'decisions', scope: 'farm' },
  ];
  const before = resourceRevisions.sample(watched);
  await expectWrite(t, write, []);
  assert.deepEqual(
    resourceRevisions.sample(watched),
    before,
    'No-op must not merely hide a publication',
  );
}
const readOwned = async () => {
  const document = JSON.parse(await readFile(statusPath, 'utf8'));
  return document.slots.find((slot: { slot: string }) => slot.slot === slotId);
};
const ownedView = () => {
  const view = fleet.getCachedFleet()?.slots.find((slot) => slot.slot === slotId);
  assert(view);
  return view;
};

for (const source of ['pool', 'project'] as const)
  test(`actual ${source} config writer publishes worker and capability keys through the private watcher`, async (t) => {
    await fixture(t);
    // OS watcher readiness uses real scheduling; the existing 2s pool refresh
    // would execute health commands, so close the owner before that debounce.
    t.mock.timers.reset();
    const file =
      source === 'pool'
        ? path.join(root, 'pool/owned.json')
        : path.join(root, 'projects/owned-project/project.json');
    if (source === 'project') {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, '{}');
    }
    const watcher = fleet.startFileWatcher();
    t.after(() => watcher.close());
    await watcher.ready;
    packets = [];
    const previous = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...previous, label: 'committed config change' }));
    const expected: ResourceKey[] = [
      { family: 'capabilities' },
      { family: 'workers', scope: 'farm' },
    ];
    const deadline = Date.now() + 1000;
    while (
      !ids(expected).every((id) =>
        packets.some((packet) => packet.changes.some((change) => resourceKeyId(change.key) === id)),
      )
    ) {
      assert(Date.now() < deadline, 'Actual config write did not reach its owner');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(
      ids(packets.flatMap((packet) => packet.changes.map((change) => change.key))),
      ids(expected),
    );
    assert.equal(JSON.parse(await readFile(file, 'utf8')).label, 'committed config change');
    await watcher.close();
  });

test('atomic status commit reaches the actual fleet owner and invalidates former membership scopes', async (t) => {
  await fixture(t);
  await expectWrite(
    t,
    () =>
      core.updateSlotStatus(slotId, {
        project: 'next-project',
        machine: 'next-node',
        phase: 'working',
      }),
    [...keys(), ...keys('next-project', 'next-node'), { family: 'workers', scope: 'farm' }],
    async () => {
      assert.equal((await readOwned()).phase, 'working');
      assert.equal(fleet.getCachedFleet(), null, 'Atomic commit listener retires cached fleet');
    },
  );
  const current = await fleet.loadFleetStatus(true, true);
  assert.equal(current.slots.find((slot) => slot.slot === slotId)?.project, 'next-project');
  await flush(t);
  assert.equal(
    packets.flatMap((packet) => packet.changes).filter((change) => change.key.family === 'workers')
      .length,
    1,
    'Rereading committed facts must not publish a second worker change',
  );
  await expectQuiet(t, () => core.updateSlotStatus(slotId, { phase: 'working' }));
  await expectQuiet(t, () => core.updateSlotStatusIf(slotId, () => false, { phase: 'forbidden' }));
  assert.equal((await readOwned()).phase, 'working');
});

test('atomic claim and guarded reset publish binding changes only after real commits', async (t) => {
  await fixture(t);
  const expected: ResourceKey[] = [
    ...keys(),
    { family: 'workers', scope: 'farm' },
    { family: 'runs', scope: 'farm' },
    { family: 'decisions', scope: 'farm' },
  ];
  await expectWrite(
    t,
    () =>
      core.claimSlotStatusIf(slotId, () => true, {
        current_run_id: 'next-run',
        lifecycle: 'busy',
      }),
    expected,
    async () => {
      const row = await readOwned();
      assert.equal(row.current_run_id, 'next-run');
      assert.equal(row.slot_epoch, 5);
    },
  );
  await expectQuiet(t, () =>
    core.claimSlotStatusIf(slotId, () => false, { current_run_id: 'foreign-run' }),
  );
  await expectWrite(
    t,
    () => core.resetSlotIf(slotId, () => true),
    expected,
    async () => {
      assert.equal((await readOwned()).current_run_id, null);
    },
  );
});

const health = {
  pr: 17,
  conflict: false,
  ciPassed: 1,
  ciFailed: 0,
  ciPending: 0,
  ciTotal: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
};
for (const overlay of [
  {
    name: 'progress',
    set: () => fleet.setTaskProgressOverlay(slotId, 'Validate', 1, 2),
    clear: () => fleet.clearTaskProgressOverlay(slotId),
    check: () => {
      assert.equal(ownedView().taskPhase, 'Validate 1/2');
      assert.equal(ownedView().taskStepProgress, 0.5);
    },
    cleared: () => assert.equal(ownedView().taskPhase, null),
  },
  {
    name: 'PR health',
    set: () => fleet.setPrHealthOverlay(slotId, { ...health }),
    clear: () => fleet.clearPrHealthOverlay(slotId),
    check: () => assert.deepEqual(ownedView().prHealth, health),
    cleared: () => assert.equal(ownedView().prHealth, undefined),
  },
  {
    name: 'branch',
    set: () => fleet.setBranchOverlay(slotId, 'feature/source'),
    clear: () => fleet.clearBranchOverlay(slotId),
    check: () => assert.equal(ownedView().branch, 'feature/source'),
    cleared: () => assert.equal(ownedView().branch, 'main'),
  },
]) {
  test(`actual ${overlay.name} overlay setter and clear publish exact slot scopes; repeats stay quiet`, async (t) => {
    await fixture(t);
    try {
      await expectWrite(t, overlay.set, keys(), overlay.check);
      await expectQuiet(t, overlay.set);
      await expectWrite(t, overlay.clear, keys(), overlay.cleared);
      await expectQuiet(t, overlay.clear);
    } finally {
      overlay.clear();
    }
  });
}

test('cached resource status and active ownership publish fleet keys; PID and stream changes stay quiet', async (t) => {
  await fixture(t);
  const resourceId = `server-${++sequence}`;
  try {
    await expectWrite(
      t,
      () => resources.setCachedResourceStatus(slotId, resourceId, 'running', { broadcast: false }),
      keys(),
      () => assert.equal(resources.getCachedResourceStatus(slotId, resourceId), 'running'),
    );
    await expectQuiet(t, () => resources.setCachedResourceStatus(slotId, resourceId, 'running'));
    const push = (pid: number, runId: string) =>
      resources.handleNodeResourceChanged({
        machine: nodeId,
        slotId,
        resourceId,
        status: 'running',
        pid,
        meta: { runId, slotId, startedAt: '2026-01-01T00:00:00.000Z' },
        at: '2026-01-01T00:00:00.000Z',
      });
    await expectWrite(
      t,
      () => push(101, 'owned-run'),
      keys(),
      () => {
        assert.equal(resources.getActiveResource(slotId, resourceId)?.runId, 'owned-run');
        assert.equal(ownedView().resourceRollup, 'coherent');
      },
    );
    await expectQuiet(t, () => push(102, 'owned-run'));
    assert.equal(resources.getActiveResource(slotId, resourceId)?.pid, 102);
    await expectQuiet(t, () =>
      resources.setResourceStreamState(slotId, resourceId, {
        state: 'ready',
        detail: 'frame available',
      }),
    );
    await expectQuiet(t, () => resources.clearResourceStreamState(slotId, resourceId));
    await expectWrite(
      t,
      () =>
        resources.handleNodeResourceChanged({
          machine: nodeId,
          slotId,
          resourceId,
          status: 'relaunched',
          oldPid: 102,
          newPid: 103,
          meta: { runId: 'former-run', slotId, startedAt: '2026-01-01T00:00:00.000Z' },
        }),
      keys(),
      () => assert.equal(ownedView().resourceRollup, 'stale'),
    );
    await expectWrite(
      t,
      () => resources.deleteActiveResource(slotId, resourceId),
      keys(),
      () => assert.equal(resources.getActiveResource(slotId, resourceId), undefined),
    );
    await expectQuiet(t, () => resources.deleteActiveResource(slotId, resourceId));
    await expectWrite(
      t,
      () => resources.setCachedResourceStatus(slotId, resourceId, 'stopped'),
      keys(),
      () => assert.equal(ownedView().resourceRollup, 'none'),
    );
    await expectQuiet(t, () => resources.setCachedResourceStatus(slotId, resourceId, 'stopped'));
  } finally {
    resources.deleteActiveResource(slotId, resourceId);
    resources.clearResourceStreamState(slotId, resourceId);
  }
});
