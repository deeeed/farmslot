import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

await import('../runtime/mock-pty.test-support.js');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'orphan-review-ownership-'));
process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_RUNS_DIR = path.join(fixture, 'runs');
process.env.FARMSLOT_POOL_DIR = path.join(fixture, 'pool');
process.env.FARMSLOT_TEST_STATUS_FILE = path.join(fixture, 'status.json');
process.env.FARMSLOT_PROJECTS_DIR = path.join(fixture, 'projects');
const slotId = 'reboot-review-fixture';
const task = path.join(fixture, 'projects', slotId, 'tasks/proof/TASK.md');
for (const directory of [
  process.env.FARMSLOT_POOL_DIR,
  path.dirname(task),
  path.join(fixture, 'repo'),
])
  await mkdir(directory, { recursive: true });
await writeFile(
  path.join(fixture, 'projects', slotId, 'project.json'),
  JSON.stringify({ name: slotId, task_dir: 'temp/tasks', hooks: {}, review: { enabled: false } }),
);
await writeFile(
  path.join(fixture, 'pool/fixture.json'),
  JSON.stringify({
    machine: os.hostname(),
    host: 'localhost',
    ssh_user: os.userInfo().username,
    platform: 'cli',
    os: process.platform,
    project: slotId,
    slots: [
      {
        id: slotId,
        enabled: true,
        mode: 'dispatch',
        repo: path.join(fixture, 'repo'),
        session: slotId,
      },
    ],
  }),
);
await writeFile(task, '# Owned replay fixture\n');
const core = await import('../core/index.js');
const store = await import('../runs/store.js');
const { withRunTransition } = await import('../run-lifecycle/transition-coordinator.js');
const { withNativeReviewOperation, withNativeReviewMutation } =
  await import('../review/native-review-operation.js');
const { reconcileOrphanedSlots } = await import('./recovery.js');
const contracts = await import('../tasks/worker-terminal-contract.js');
let readContract: typeof contracts.readFrozenWorkerTerminalContractForRun = async () => null;
mock.module('../tasks/worker-terminal-contract.js', {
  namedExports: {
    ...contracts,
    readFrozenWorkerTerminalContractForRun: (...args: Parameters<typeof readContract>) =>
      readContract(...args),
  },
});
const replayModule: string = '../methods/run/replay-step.js?orphan-replay-path';
const { runReplayStep }: typeof import('../methods/run/replay-step.js') = await import(
  replayModule
);
type Collaborators = Parameters<typeof reconcileOrphanedSlots>[0];
after(() => rm(fixture, { recursive: true, force: true }));

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function setup(t: import('node:test').TestContext) {
  const created = store.createRun(
    {
      flowType: 'dev',
      project: 'reboot-review-fixture',
      ticketOrPr: 'PROOF-1',
      slotId,
      transport: 'tmux',
    },
    { deferBackgroundPersist: true },
  );
  store.updateRun(created.id, { status: 'failed', engineState: { generation: 5 } });
  await writeFile(
    process.env.FARMSLOT_TEST_STATUS_FILE!,
    JSON.stringify({
      slots: [
        {
          slot: slotId,
          lifecycle: 'busy',
          phase: 'working',
          current_run_id: created.id,
          slot_epoch: 1,
        },
      ],
    }),
  );
  t.after(async () => {
    await store.persistRunNow(store.updateRun(created.id, { status: 'done' }), 'fixture cleanup');
    await store.deleteRun(created.id);
  });
  const deps: Collaborators = {
    listRuns: () => {
      const run = store.getRun(created.id)!;
      return { runs: run.status === 'failed' ? [] : [run] };
    },
    loadFleetStatus: async () => ({
      slots: [{ slot: slotId, lifecycle: 'busy', phase: 'preparing' }],
    }),
    isTerminalTeardownInFlight: () => false,
    readSlotField: core.readSlotField,
    getRun: store.getRun,
    updateRun: store.updateRun,
    stopRunOwnedWorkers: async () => null,
    resetSlot: core.resetSlot,
    resetSlotIf: core.resetSlotIf,
    updateSlotStatusIf: core.updateSlotStatusIf,
    broadcast: () => {},
    retryOccupiedRunSlot: async () => false,
  };
  return { id: created.id, deps };
}

for (const statusChangesBeforeFleetReturns of [true, false]) {
  test(`slow node refresh cannot clear a replayed review claim ${statusChangesBeforeFleetReturns ? 'after' : 'before'} its run status changes`, async (t) => {
    const { id, deps } = await setup(t);
    const fleetWaiting = latch();
    const releaseFleet = latch();
    deps.loadFleetStatus = async () => {
      fleetWaiting.release();
      await releaseFleet.promise;
      return { slots: [{ slot: slotId, lifecycle: 'busy', phase: 'preparing' }] };
    };
    const reconcile = reconcileOrphanedSlots(deps);
    await fleetWaiting.promise;
    await withRunTransition(id, async () => {
      await core.claimSlotStatusIf(slotId, (row) => row.current_run_id === id, {
        lifecycle: 'busy',
        phase: 'preparing',
        current_run_id: id,
      });
      if (statusChangesBeforeFleetReturns)
        store.updateRun(id, { status: 'reviewing', engineState: { generation: 6 } });
      releaseFleet.release();
      for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        await core.readSlotField(slotId, 'current_run_id'),
        id,
        'a replay still owns its claim while reconciliation awaits',
      );
      store.updateRun(id, { status: 'reviewing', engineState: { generation: 6 } });
    });
    await reconcile;
    assert.equal(await core.readSlotField(slotId, 'current_run_id'), id);
    let mutated = false;
    await withNativeReviewOperation(store.getRun(id)!, () =>
      withNativeReviewMutation(async () => {
        mutated = true;
      }),
    );
    assert.equal(
      mutated,
      true,
      'the original native review ownership fence still accepts the replayed owner',
    );
  });
}

for (const status of ['failed', 'done'] as const) {
  test(
    `the public ${status} review replay retains its claim while awaiting the worker contract`,
    { timeout: 5_000 },
    async (t) => {
      const { id, deps } = await setup(t);
      const initial = store.getRun(id)!;
      store.updateRun(id, {
        status,
        taskFile: task,
        steps: initial.steps.map((step) => ({
          ...step,
          status: step.name === 'review' ? 'failed' : 'done',
        })),
      });
      const fleetEntered = latch(),
        releaseFleet = latch(),
        contractEntered = latch(),
        releaseContract = latch();
      deps.listRuns = () => {
        const current = store.getRun(id)!;
        return { runs: ['failed', 'done'].includes(current.status) ? [] : [current] };
      };
      deps.loadFleetStatus = async () => {
        fleetEntered.release();
        await releaseFleet.promise;
        return { slots: [{ slot: slotId, lifecycle: 'busy', phase: 'preparing' }] };
      };
      readContract = async () => {
        contractEntered.release();
        await releaseContract.promise;
        return null;
      };
      const reconcile = reconcileOrphanedSlots(deps);
      await fleetEntered.promise;
      const replay = runReplayStep({ runId: id, stepName: 'review' }, () => {}, {
        startEngine: async () => {},
      });
      try {
        await Promise.race([
          contractEntered.promise,
          replay.then(() => {
            throw new Error('Replay did not reach its post-claim contract read');
          }),
        ]);
        assert.equal(
          store.getRun(id)!.status,
          status,
          'the production replay is still terminal across this await',
        );
        releaseFleet.release();
        for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(await core.readSlotField(slotId, 'current_run_id'), id);
        releaseContract.release();
        await replay;
        await reconcile;
        await withNativeReviewOperation(store.getRun(id)!, () =>
          withNativeReviewMutation(async () => {}),
        );
      } finally {
        releaseFleet.release();
        releaseContract.release();
        await Promise.allSettled([replay, reconcile]);
        readContract = async () => null;
      }
    },
  );
}
