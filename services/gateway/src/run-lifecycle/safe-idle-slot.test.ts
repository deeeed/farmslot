import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import type { Run, SlotStatus, SlotWorkspace } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const fleet = await import('../fleet/state.js');
const work = await import('../methods/slot/workspace.js');
const recovery = await import('../methods/slot/recover-workspace.js');
const store = await import('../runs/store.js');
const { makeRun } = await import('../run-engine/test-fixtures.js');
let workspace: SlotWorkspace;
let runs: Run[];
let recovered: SlotWorkspace[];
let modes: (string | undefined)[];
let failure: string | undefined;
const slot: SlotStatus = {
  slot: 'proof',
  machine: 'local',
  project: 'proof',
  platform: 'cli',
  branch: 'main',
  enabled: true,
  dispatchable: true,
  lifecycle: 'ready',
  phase: null,
  agent: 'idle',
  warm: false,
  health: { ssh: 'OK', device: '-', devserver: 'OFF', cdp: 'OFF', fixtures: 'OK' },
  taskId: null,
  taskFile: null,
  dispatchedAt: null,
  completedAt: null,
  runner: null,
  model: null,
  deviceName: null,
  taskPhase: null,
  taskStepProgress: null,
};
mock.module('../fleet/state.js', {
  namedExports: { ...fleet, loadFleetStatus: async () => ({ slots: [slot] }) },
});
mock.module('../methods/slot/workspace.js', {
  namedExports: { ...work, inspectSlotWorkspace: async () => workspace },
});
mock.module('../methods/slot/recover-workspace.js', {
  namedExports: {
    ...recovery,
    recoverSlotWorkspace: async (
      params: Parameters<typeof recovery.recoverSlotWorkspace>[0],
      _emit: unknown,
      _signal: unknown,
      options: Parameters<typeof recovery.recoverSlotWorkspace>[3],
    ) => {
      modes.push(params.mode);
      parkRunIds.push(options?.parkRunId);
      assert.equal(options?.skipRecycle, true, 'automatic recovery explicitly keeps runtime cold');
      assert.ok(params.expectedWorkspace);
      recovered.push(workspace);
      return failure ? { refreshed: false, detail: failure } : { refreshed: true };
    },
  },
});
const state = await import('../core/state.js');
let slotRow: Record<string, unknown> | null = null;
mock.module('../core/state.js', {
  namedExports: { ...state, readSlotRow: async () => slotRow },
});
let parkRunIds: (string | undefined)[];
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getAllRuns: () => runs,
    getRun: (id: string) => runs.find((run) => run.id === id),
    persistRunNow: async () => {},
    updateRunStep: (id: string, name: string, patch: Partial<Run['steps'][number]>) => {
      const run = runs.find((run) => run.id === id)!;
      Object.assign(run.steps.find((step) => step.name === name)!, patch);
      return run;
    },
  },
});
const { reuseSafeIdleSlot, checkoutBeforeIdleReturn, returnReleasedCheckoutToIdle } =
  await import('./safe-idle-slot.js');
beforeEach(() => {
  workspace = {
    epoch: 7,
    currentRunId: null,
    cleanupRunId: null,
    handoffRunId: null,
    recoveryId: null,
    branch: 'fix/merged',
    headSha: 'a'.repeat(40),
    dirtyFingerprint: 'b'.repeat(64),
    observedAt: new Date().toISOString(),
    defaultBranch: 'main',
    localDefaultSha: 'c'.repeat(40),
    defaultFetchedAt: null,
    remoteDefaultSha: 'c'.repeat(40),
    remoteObservedAt: new Date().toISOString(),
    behind: 1,
    remoteAdvanced: false,
    publication: 'merged',
    dirtyCount: 0,
    unpublishedCount: 0,
  };
  runs = [];
  recovered = [];
  modes = [];
  failure = undefined;
  parkRunIds = [];
  slotRow = null;
});
for (const publication of ['baseline', 'merged', 'pushed'] as const) {
  test(`clean ${publication} work uses fenced safe recovery`, async () => {
    workspace.publication = publication;
    assert.deepEqual(await reuseSafeIdleSlot('proof', () => {}), { kind: 'ready' });
    assert.equal(recovered.length, 1);
    assert.deepEqual(modes, ['safe']);
  });
}
for (const kind of ['dirty', 'unpushed'] as const) {
  test(`a finished blind trial's ${kind} candidate returns to idle; its branch and first output are kept`, async () => {
    if (kind === 'dirty') workspace.dirtyCount = 1;
    else workspace.publication = 'unpushed';
    assert.deepEqual(
      await reuseSafeIdleSlot('proof', () => {}, {
        epoch: 7,
        runId: null,
        retainedCandidate: true,
      }),
      { kind: 'ready' },
    );
    assert.deepEqual(modes, ['force']);
  });
}
for (const kind of ['dirty', 'unpushed'] as const) {
  test(`${kind} work on main is preserved despite its branch name`, async () => {
    workspace.branch = 'main';
    if (kind === 'dirty') workspace.dirtyCount = 1;
    else workspace.publication = 'unpushed';
    const result = await reuseSafeIdleSlot('proof', () => {});
    assert.equal(result.kind, 'local-work');
    assert.deepEqual(recovered, []);
  });
}
// F291 (c9562e49 on mini-mmt-3): a finished artifact-only run's own commits kept the next dispatch
// off its slot. Its idle return now asks the release to park them (the release owns the git).
const validationRun = (overrides: Partial<Run> = {}) =>
  makeRun({
    id: 'validation',
    slotId: 'proof',
    flowType: 'dev',
    completionPolicy: 'artifact-only',
    branch: 'TAT-4146-feat-farm-validation',
    status: 'done',
    worktreeHeadAtDispatch: 'd'.repeat(40),
    steps: [{ name: 'prepare', status: 'done' }],
    ...overrides,
  });
const releaseFor = (runId: string) =>
  reuseSafeIdleSlot('proof', () => {}, { epoch: 7, runId: null, recordRunId: runId });

test("a finished artifact-only run's own unpushed checkout returns to idle through a parking release", async () => {
  const run = validationRun();
  runs = [run];
  workspace.branch = run.branch!;
  workspace.publication = 'unpushed';
  assert.deepEqual(await releaseFor(run.id), { kind: 'ready' });
  assert.deepEqual(modes, ['force']);
  assert.deepEqual(parkRunIds, ['validation']);
});

test("work that isn't a finished artifact-only run's own is still kept", async () => {
  workspace.publication = 'unpushed';
  for (const [label, run, setup] of [
    ['a publishing run', validationRun({ completionPolicy: 'default' }), () => {}],
    ['a run still working', validationRun({ status: 'monitoring' }), () => {}],
    ['another branch', validationRun(), () => (workspace.branch = 'someone-else')],
    ['dirty files', validationRun(), () => (workspace.dirtyCount = 1)],
  ] as const) {
    runs = [run];
    workspace.branch = run.branch!;
    workspace.dirtyCount = 0;
    setup();
    assert.equal((await releaseFor(run.id)).kind, 'local-work', label);
  }
  // Without a named run nothing is parked, however parkable the checkout looks.
  runs = [validationRun()];
  workspace.branch = 'TAT-4146-feat-farm-validation';
  assert.equal(
    (await reuseSafeIdleSlot('proof', () => {}, { epoch: 7, runId: null })).kind,
    'local-work',
  );
  assert.deepEqual(recovered, []);
});

test('a checkout COMPLETE already released returns to idle when its run closes', async () => {
  const run = validationRun();
  runs = [run];
  workspace.branch = run.branch!;
  workspace.publication = 'unpushed';
  for (const owner of ['successor', null] as const) {
    slotRow = { slot_epoch: 7, current_run_id: owner, cleanup_run_id: null, handoff_run_id: null };
    const result = await returnReleasedCheckoutToIdle(run, () => {});
    if (owner) assert.equal(result, null, 'a slot another run owns is left alone');
    else assert.deepEqual(result, { kind: 'ready' });
  }
  assert.deepEqual(parkRunIds, ['validation']);
  assert.equal(
    await returnReleasedCheckoutToIdle({ ...run, status: 'completing' }, () => {}),
    null,
  );
});

test('unknown publication and a deleted remote ref never grant reset authority', async () => {
  workspace.publication = 'unknown';
  workspace.error = 'Publication ref is absent';
  for (const retainedCandidate of [false, true])
    assert.deepEqual(
      await reuseSafeIdleSlot('proof', () => {}, { epoch: 7, runId: null, retainedCandidate }),
      { kind: 'unavailable', reason: workspace.error },
    );
  assert.deepEqual(recovered, []);
});
test('a released successor epoch refuses an older terminal cleanup', async () => {
  const result = await reuseSafeIdleSlot('proof', () => {}, { epoch: 6, runId: null });
  assert.equal(result.kind, 'unavailable');
  assert.deepEqual(recovered, []);
});
test('a foreign owner or handoff refuses terminal normalization', async () => {
  for (const field of ['currentRunId', 'handoffRunId', 'cleanupRunId'] as const) {
    workspace[field] = 'successor';
    assert.equal(
      (await reuseSafeIdleSlot('proof', () => {}, { epoch: 7, runId: null })).kind,
      'unavailable',
    );
    workspace[field] = null;
  }
  assert.deepEqual(recovered, []);
});
test('retains settlement HEAD rather than dispatch HEAD before normalization', async () => {
  const run = makeRun({
    id: 'old',
    slotId: 'proof',
    branch: workspace.branch,
    status: 'done',
    worktreeHeadAtDispatch: 'd'.repeat(40),
    steps: [{ name: 'prepare', status: 'done' }],
  });
  runs = [run];
  await reuseSafeIdleSlot('proof', () => {});
  assert.deepEqual(checkoutBeforeIdleReturn(run), {
    slotId: 'proof',
    branch: workspace.branch,
    headSha: workspace.headSha,
  });
});
test('a failed recovery remains unavailable with its actual reason', async () => {
  failure = 'Fixture verification failed';
  assert.deepEqual(await reuseSafeIdleSlot('proof', () => {}), {
    kind: 'unavailable',
    reason: failure,
  });
});

test('a parked predecessor protects an ownerless workspace but permits a named finished successor', async (t) => {
  const parked = store.createRun({
    project: 'proof',
    flowType: 'dev',
    mode: 'autonomous',
    ticketOrPr: 'PROOF-PARK',
  });
  const successor = store.createRun({
    project: 'proof',
    flowType: 'dev',
    mode: 'autonomous',
    ticketOrPr: 'PROOF-SUCCESSOR',
  });
  t.after(async () => {
    for (const run of [parked, successor]) {
      store.updateRun(run.id, { status: 'done', slotId: null, park: undefined });
      await store.deleteRun(run.id);
    }
  });
  const at = new Date().toISOString();
  store.updateRun(parked.id, {
    status: 'human-gating',
    slotId: 'proof',
    steps: [
      { name: 'complete', status: 'done', outputs: { slotDisposition: 'gate-held' } },
      { name: 'human-gate', status: 'running' },
    ],
    park: {
      version: 1,
      operationId: 'park-operation',
      previewId: 'preview',
      runId: parked.id,
      generation: 0,
      machine: 'local',
      slotId: 'proof',
      mode: 'release',
      phase: 'parked',
      slotDisposition: 'freed',
      slotFreedAt: at,
      prePauseStatus: 'human-gating',
      prePauseCurrentStep: { index: 1, name: 'human-gate', status: 'running' },
      resourceManifest: { capturedAt: at, resources: [], capabilityLeases: [] },
      recoveryHandle: null,
      errors: [],
      residuals: { runner: 'stopped', resources: [] },
      createdAt: at,
      updatedAt: at,
    },
  });
  store.updateRun(successor.id, { status: 'done', slotId: 'proof' });
  const gates = await import('../run-engine/gate-held-lifecycle.js');
  assert.equal(
    gates.findGateParkedRunForSlot('proof')?.id,
    parked.id,
    'fixture is an actual retained gate park',
  );
  assert.match(
    (await work.workspaceProtectedReason('proof', { current_run_id: null })) ?? '',
    /parked workspace/,
  );
  assert.equal(
    await work.workspaceProtectedReason('proof', { current_run_id: successor.id }),
    undefined,
  );
  assert.equal(store.getRun(parked.id)?.park?.slotDisposition, 'freed');
});

test('an active skip-prepare successor protects a finished parent checkout', async (t) => {
  const child = store.createRun({
    project: 'proof',
    flowType: 'dev',
    mode: 'autonomous',
    ticketOrPr: 'PROOF-PINNED',
  });
  t.after(async () => {
    store.updateRun(child.id, { status: 'done', slotId: null });
    await store.deleteRun(child.id);
  });
  store.updateRun(child.id, {
    status: 'monitoring',
    slotId: 'proof',
    engineState: { generation: 0, flags: { skipPrepare: true } },
    steps: [{ name: 'find-slot', status: 'done' }],
  });
  assert.match(
    (await work.workspaceProtectedReason('proof', { current_run_id: 'finished-parent' })) ?? '',
    /still needs this checkout/,
  );
});

test('a successor settlement cannot replace the predecessor checkout receipt', async () => {
  const predecessor = makeRun({
    id: 'predecessor',
    slotId: 'proof',
    branch: workspace.branch,
    status: 'done',
    steps: [
      {
        name: 'prepare',
        status: 'done',
        outputs: {
          checkoutBeforeIdleReturn: {
            slotId: 'proof',
            branch: workspace.branch,
            headSha: '1'.repeat(40),
          },
        },
      },
    ],
  });
  const successor = makeRun({
    id: 'successor',
    slotId: 'proof',
    branch: workspace.branch,
    status: 'done',
    steps: [{ name: 'prepare', status: 'done' }],
  });
  runs = [predecessor, successor];
  workspace.currentRunId = successor.id;
  await reuseSafeIdleSlot('proof', () => {}, {
    epoch: 7,
    runId: successor.id,
    recordRunId: successor.id,
  });
  assert.equal(checkoutBeforeIdleReturn(predecessor)?.headSha, '1'.repeat(40));
  assert.equal(checkoutBeforeIdleReturn(successor)?.headSha, workspace.headSha);
  workspace.headSha = '2'.repeat(40);
  await reuseSafeIdleSlot('proof', () => {}, {
    epoch: 7,
    runId: successor.id,
    recordRunId: successor.id,
  });
  assert.equal(checkoutBeforeIdleReturn(predecessor)?.headSha, '1'.repeat(40));
  assert.equal(
    checkoutBeforeIdleReturn(successor)?.headSha,
    workspace.headSha,
    'the named run can record its own later settlement',
  );
});
