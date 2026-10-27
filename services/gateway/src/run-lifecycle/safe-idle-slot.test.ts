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
    recoverSlotWorkspace: async (params: Parameters<typeof recovery.recoverSlotWorkspace>[0]) => {
      assert.equal(params.mode, 'safe');
      assert.ok(params.expectedWorkspace);
      recovered.push(workspace);
      return failure ? { refreshed: false, detail: failure } : { refreshed: true };
    },
  },
});
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
const { reuseSafeIdleSlot, checkoutBeforeIdleReturn } = await import('./safe-idle-slot.js');
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
  failure = undefined;
});
for (const publication of ['baseline', 'merged', 'pushed'] as const) {
  test(`clean ${publication} work uses fenced safe recovery`, async () => {
    workspace.publication = publication;
    assert.deepEqual(await reuseSafeIdleSlot('proof', () => {}), { kind: 'ready' });
    assert.equal(recovered.length, 1);
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
test('unknown publication and a deleted remote ref never grant reset authority', async () => {
  workspace.publication = 'unknown';
  workspace.error = 'Publication ref is absent';
  assert.deepEqual(await reuseSafeIdleSlot('proof', () => {}), {
    kind: 'unavailable',
    reason: workspace.error,
  });
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
