import assert from 'node:assert/strict';
import test from 'node:test';

import {
  gateParkGateNotice,
  gateParkStateLabel,
  gateParkSummaryLine,
  gateParkView,
  hasLiveParkRecord,
  isGateParkInFlightOrFreed,
  isSlotFreedByPark,
  liveGateParkView,
  MACHINE_PARK_RESTORE_STAGES,
  MachineParkEligibilityCodes,
  type MachineParkRecord,
  needsGateParkRestore,
  type Run,
} from '../src/index.js';

function parkRecord(overrides: Partial<MachineParkRecord> = {}): MachineParkRecord {
  return {
    version: 1,
    operationId: 'op-1',
    previewId: 'preview-1',
    runId: 'run-1',
    generation: 3,
    machine: 'macwork',
    slotId: 'macwork-ff-1',
    mode: 'release',
    phase: 'parked',
    prePauseStatus: 'human-gating',
    prePauseCurrentStep: { index: 4, name: 'human-gate', status: 'running' },
    resourceManifest: {
      capturedAt: '2026-09-05T10:00:00.000Z',
      resources: [],
      capabilityLeases: [],
    },
    recoveryHandle: null,
    errors: [],
    residuals: { runner: 'stopped', resources: [] },
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
    ...overrides,
  };
}

function runWith(park: MachineParkRecord | null): Pick<Run, 'id' | 'park'> {
  return { id: 'run-1', park };
}

test('a run with no park record has no gate park view', () => {
  assert.equal(gateParkView(runWith(null)), null);
  assert.equal(liveGateParkView(runWith(null)), null);
});

test('a retained park reports its slot as held and needs no restore before the gate', () => {
  const view = gateParkView(runWith(parkRecord({ slotDisposition: 'retained' })));
  assert.ok(view);
  assert.equal(view.slotState, 'retained');
  assert.equal(view.slotDisposition, 'retained');
  assert.equal(view.freedSlotId, null);
  assert.equal(view.restoreBeforeGateAnswer, false);
  // Nothing told this client whether the slot could take the run back.
  assert.deepEqual(view.restoreTarget, {
    slotId: 'macwork-ff-1',
    disposition: 'retained',
    available: null,
  });
  assert.equal(view.restoreStage.state, 'not-started');
  assert.deepEqual(view.restoreStage.remaining, MACHINE_PARK_RESTORE_STAGES);
});

test('a record written before slot freeing existed reads as retained', () => {
  const view = gateParkView(runWith(parkRecord({})));
  assert.ok(view);
  assert.equal(view.slotDisposition, 'retained');
  assert.equal(view.slotState, 'retained');
});

test('a freeing park whose release has not landed is not advertised as freed', () => {
  const park = parkRecord({ slotDisposition: 'freed', phase: 'resources-stopping' });
  const view = gateParkView(runWith(park));
  assert.ok(view);
  assert.equal(view.slotState, 'freeing');
  assert.equal(view.freedSlotId, null, 'the slot is not free until the release lands');
  assert.equal(view.restoreBeforeGateAnswer, false);
  // The fence is up even though nothing is restorable yet.
  assert.equal(isGateParkInFlightOrFreed({ park }), true);
});

test('a landed freeing park reports the freed slot, its branch, and the restore it owes', () => {
  const park = parkRecord({
    slotDisposition: 'freed',
    slotFreedAt: '2026-09-05T10:05:00.000Z',
    preservedWorkspace: {
      branch: 'feat/free-slot',
      headSha: 'abc1234',
      detachedAt: '2026-09-05T10:04:00.000Z',
    },
  });
  const view = gateParkView(runWith(park));
  assert.ok(view);
  assert.equal(view.slotState, 'freed');
  assert.equal(view.freedSlotId, 'macwork-ff-1');
  assert.equal(view.slotFreedAt, '2026-09-05T10:05:00.000Z');
  assert.equal(view.preservedWorkspace?.branch, 'feat/free-slot');
  assert.equal(view.preservedWorkspace?.headSha, 'abc1234');
  assert.equal(view.restoreBeforeGateAnswer, true);
  assert.equal(isSlotFreedByPark({ park }), true);
  assert.equal(liveGateParkView(runWith(park))?.slotState, 'freed');
});

test('a Gateway restore verdict is carried through instead of being derived', () => {
  const park = parkRecord({ slotDisposition: 'freed', slotFreedAt: '2026-09-05T10:05:00.000Z' });
  const view = gateParkView(runWith(park), {
    target: { slotId: 'macwork-ff-1', disposition: 'freed', available: true },
    eligibility: {
      code: 'ELIGIBLE_FREED_SLOT_RESTORE',
      reason: 'The freed slot is still free and the persisted runner session is reloadable.',
    },
  });
  assert.ok(view);
  assert.deepEqual(view.restoreTarget, {
    slotId: 'macwork-ff-1',
    disposition: 'freed',
    available: true,
    code: 'ELIGIBLE_FREED_SLOT_RESTORE',
    reason: 'The freed slot is still free and the persisted runner session is reloadable.',
  });
});

test('an unavailable restore target keeps the run parked and reports the typed refusal', () => {
  const park = parkRecord({
    slotDisposition: 'freed',
    slotFreedAt: '2026-09-05T10:05:00.000Z',
    restoreRefusal: {
      code: MachineParkEligibilityCodes.restoreSlotTaken,
      reason: 'macwork-ff-1 is now running run-9',
      at: '2026-09-05T11:00:00.000Z',
    },
  });
  const view = gateParkView(runWith(park), {
    target: { slotId: 'macwork-ff-1', disposition: 'freed', available: false },
    eligibility: {
      code: MachineParkEligibilityCodes.restoreSlotTaken,
      reason: 'macwork-ff-1 is now running run-9',
    },
  });
  assert.ok(view);
  assert.equal(view.restoreTarget.available, false);
  assert.equal(view.restoreTarget.code, 'RESTORE_SLOT_TAKEN');
  assert.equal(view.refusal?.code, 'RESTORE_SLOT_TAKEN');
  assert.equal(view.refusal?.reason, 'macwork-ff-1 is now running run-9');
  // A refusal changed nothing: the run is still parked and still owes a restore.
  assert.equal(view.slotState, 'freed');
  assert.equal(view.restoreBeforeGateAnswer, true);
});

test('a refusal alone never invents an availability answer', () => {
  const park = parkRecord({
    slotDisposition: 'freed',
    slotFreedAt: '2026-09-05T10:05:00.000Z',
    restoreRefusal: {
      code: MachineParkEligibilityCodes.restoreWorkspaceUnavailable,
      reason: 'the successor left uncommitted work in the tree',
      at: '2026-09-05T11:00:00.000Z',
    },
  });
  const view = gateParkView(runWith(park));
  assert.ok(view);
  assert.equal(view.restoreTarget.available, null, 'only the Gateway answers availability');
  assert.equal(view.refusal?.code, 'RESTORE_WORKSPACE_UNAVAILABLE');
});

test('a partly restored record reports the stage it is on and what it still owes', () => {
  const park = parkRecord({
    slotDisposition: 'freed',
    slotFreedAt: '2026-09-05T10:05:00.000Z',
    slotReboundAt: '2026-09-05T11:00:00.000Z',
    restoreProgress: {
      operationId: 'restore-1',
      attempting: 'reacquire',
      completed: ['rebind', 'reattach'],
      updatedAt: '2026-09-05T11:00:05.000Z',
    },
  });
  const view = gateParkView(runWith(park));
  assert.ok(view);
  assert.equal(view.slotState, 'restoring');
  assert.equal(view.freedSlotId, null, 'the slot is back under the run');
  assert.equal(view.restoreBeforeGateAnswer, true, 'the restore still owes stages');
  assert.equal(view.restoreStage.state, 'in-progress');
  assert.equal(view.restoreStage.attempting, 'reacquire');
  assert.deepEqual(view.restoreStage.completed, ['rebind', 'reattach']);
  assert.deepEqual(view.restoreStage.remaining, ['reacquire', 'reload']);
});

test('every stage landed with nothing attempted is a complete restore stage view', () => {
  const park = parkRecord({
    slotDisposition: 'freed',
    slotFreedAt: '2026-09-05T10:05:00.000Z',
    slotReboundAt: '2026-09-05T11:00:00.000Z',
    phase: 'partial',
    restoreProgress: {
      operationId: 'restore-1',
      completed: ['rebind', 'reattach', 'reacquire', 'reload'],
      updatedAt: '2026-09-05T11:00:05.000Z',
    },
  });
  const view = gateParkView(runWith(park));
  assert.ok(view);
  assert.equal(view.restoreStage.state, 'complete');
  assert.deepEqual(view.restoreStage.remaining, []);
  // Complete stages are NOT a settled record: only `restored` ends the
  // obligation, because the orchestration resume after them can still fail.
  assert.equal(view.restoreBeforeGateAnswer, true);
  assert.equal(view.slotState, 'restoring');
});

test('a settled record reports how the worker was proven back and is not a live gate park', () => {
  const park = parkRecord({
    slotDisposition: 'freed',
    phase: 'restored',
    slotReboundAt: '2026-09-05T11:00:00.000Z',
    restoredGeneration: 4,
    recoveryProof: {
      sessionId: 'session-7',
      live: true,
      acknowledgement: {
        kind: 'adopted',
        source: 'session-binding',
        reason: 'the worker was already running this run persisted session',
      },
      acceptedAt: '2026-09-05T11:01:00.000Z',
    },
  });
  const view = gateParkView(runWith(park));
  assert.ok(view);
  assert.equal(view.slotState, 'settled');
  assert.equal(view.restoreBeforeGateAnswer, false);
  assert.deepEqual(view.workerProof, {
    kind: 'adopted',
    reason: 'the worker was already running this run persisted session',
    acceptedAt: '2026-09-05T11:01:00.000Z',
  });
  assert.equal(hasLiveParkRecord({ park }), false);
  assert.equal(
    liveGateParkView(runWith(park)),
    null,
    'a resolved park must not render beside a live gate',
  );
});

test('a structured acknowledgement is distinguishable from an adopted one', () => {
  const park = parkRecord({
    slotDisposition: 'freed',
    phase: 'restored',
    recoveryProof: {
      sessionId: 'session-7',
      live: true,
      acknowledgement: {
        kind: 'structured',
        source: 'runner-hook',
        reason: 'continuation prompt acknowledged',
        turnToken: 'turn-12',
      },
      acceptedAt: '2026-09-05T11:01:00.000Z',
    },
  });
  assert.equal(gateParkView(runWith(park))?.workerProof?.kind, 'structured');
});

test('a legacy freed record that cleared its marker at the rebind still owes a restore', () => {
  const park = parkRecord({
    slotDisposition: 'freed',
    slotReboundAt: '2026-09-05T11:00:00.000Z',
    phase: 'partial',
  });
  assert.equal(needsGateParkRestore({ park }), true);
  const view = gateParkView(runWith(park));
  assert.equal(view?.slotState, 'restoring');
  assert.equal(view?.restoreStage.state, 'not-started');
});

test('the gate notice tells the operator that answering restores the run first', () => {
  const view = gateParkView(
    runWith(parkRecord({ slotDisposition: 'freed', slotFreedAt: '2026-09-05T10:05:00.000Z' })),
  );
  const notice = gateParkGateNotice(view);
  assert.deepEqual(notice, {
    kind: 'restore-first',
    blocking: false,
    message:
      'Answering this gate restores the run into macwork-ff-1 first, then resolves the decision.',
  });
});

test('an unknown availability never blocks the answer', () => {
  const view = gateParkView(
    runWith(parkRecord({ slotDisposition: 'freed', slotFreedAt: '2026-09-05T10:05:00.000Z' })),
  );
  assert.equal(view?.restoreTarget.available, null);
  assert.equal(gateParkGateNotice(view)?.kind, 'restore-first');
});

test('a taken slot blocks the answer and carries the typed refusal', () => {
  const view = gateParkView(
    runWith(
      parkRecord({
        slotDisposition: 'freed',
        slotFreedAt: '2026-09-05T10:05:00.000Z',
        restoreRefusal: {
          code: MachineParkEligibilityCodes.restoreSlotTaken,
          reason: 'macwork-ff-1 is now running run-9',
          at: '2026-09-05T11:00:00.000Z',
        },
      }),
    ),
    {
      target: { slotId: 'macwork-ff-1', disposition: 'freed', available: false },
      eligibility: {
        code: MachineParkEligibilityCodes.restoreSlotTaken,
        reason: 'macwork-ff-1 is now running run-9',
      },
    },
  );
  const notice = gateParkGateNotice(view);
  assert.equal(notice?.kind, 'restore-blocked');
  assert.match(notice!.message, /restores the run into macwork-ff-1 first/u);
  assert.match(notice!.message, /macwork-ff-1 is now running run-9/u);
  assert.equal(notice?.refusal?.code, 'RESTORE_SLOT_TAKEN');
});

test('a park still landing says the gate cannot be answered yet', () => {
  const view = gateParkView(
    runWith(parkRecord({ slotDisposition: 'freed', phase: 'runner-stopping' })),
  );
  assert.deepEqual(gateParkGateNotice(view), {
    kind: 'park-in-flight',
    blocking: true,
    message: 'A free-slot park is still landing for this run, so its gate cannot be answered yet.',
  });
});

test('a retained park and a settled one add no gate notice', () => {
  assert.equal(gateParkGateNotice(gateParkView(runWith(parkRecord()))), null);
  assert.equal(
    gateParkGateNotice(
      gateParkView(runWith(parkRecord({ slotDisposition: 'freed', phase: 'restored' }))),
    ),
    null,
  );
  assert.equal(gateParkGateNotice(null), null);
});

test('the summary line names the freed slot, the preserved branch, and what the restore owes', () => {
  const view = gateParkView(
    runWith(
      parkRecord({
        slotDisposition: 'freed',
        slotFreedAt: '2026-09-05T10:05:00.000Z',
        preservedWorkspace: {
          branch: 'feat/free-slot',
          headSha: 'abc1234',
          detachedAt: '2026-09-05T10:04:00.000Z',
        },
        restoreProgress: {
          operationId: 'restore-1',
          attempting: 'reload',
          completed: ['rebind', 'reattach', 'reacquire'],
          updatedAt: '2026-09-05T11:00:05.000Z',
        },
      }),
    ),
  );
  assert.ok(view);
  assert.equal(gateParkStateLabel(view), 'Parked, slot freed for dispatch');
  assert.equal(
    gateParkSummaryLine(view),
    'Parked, slot freed for dispatch · slot macwork-ff-1 · branch feat/free-slot at abc1234 (detached) · restore owes reload · attempting reload',
  );
});

test('a partial park that stopped short of the slot with a live worker is answerable', () => {
  // The failure the surfaces used to get wrong: a `free-slot` park that died
  // during resource stop, before it touched the runner and before any detach.
  // The Gateway's own fence leaves this gate answerable, so no surface may say
  // it cannot be answered.
  const park = parkRecord({
    slotDisposition: 'freed',
    phase: 'partial',
    residuals: { runner: 'running', resources: [] },
  });
  assert.equal(isGateParkInFlightOrFreed({ park }), false, 'the Gateway does not fence this run');
  const view = gateParkView(runWith(park));
  assert.ok(view);
  assert.equal(view.slotState, 'partial-answerable');
  assert.equal(view.freedSlotId, null);
  assert.equal(view.restoreBeforeGateAnswer, false);
  assert.equal(gateParkStateLabel(view), 'Park failed before the slot; worker still running');

  const notice = gateParkGateNotice(view);
  assert.equal(notice?.kind, 'park-answerable');
  assert.equal(notice?.blocking, false);
  assert.match(notice.message, /can be answered where it stands/u);
  assert.doesNotMatch(notice.message, /cannot be answered/u);
});

test('a partial park with a stopped worker owes an explicit restore', () => {
  const park = parkRecord({
    slotDisposition: 'freed',
    phase: 'partial',
    residuals: { runner: 'stopped', resources: [] },
  });
  assert.equal(isGateParkInFlightOrFreed({ park }), true, 'the Gateway fences this run');
  const view = gateParkView(runWith(park));
  assert.equal(view?.slotState, 'partial-needs-restore');
  assert.equal(gateParkStateLabel(view!), 'Park failed partway; needs a restore');

  const notice = gateParkGateNotice(view);
  assert.equal(notice?.kind, 'park-needs-restore');
  assert.equal(notice?.blocking, true);
  // Waiting cannot help a park that has already stopped, so the copy must not
  // suggest it.
  assert.doesNotMatch(notice.message, /still landing/u);
  assert.match(notice.message, /Waiting will not clear it/u);
  assert.match(notice.message, /restore the run into macwork-ff-1, or cancel it/u);
});

test('a partial park whose worker cannot be observed is fenced, not assumed alive', () => {
  const park = parkRecord({
    slotDisposition: 'freed',
    phase: 'partial',
    residuals: { runner: 'unknown', resources: [] },
  });
  assert.equal(gateParkView(runWith(park))?.slotState, 'partial-needs-restore');
});

test('a partial park with an outstanding detach owes a restore even with a live worker', () => {
  const park = parkRecord({
    slotDisposition: 'freed',
    phase: 'partial',
    residuals: { runner: 'running', resources: [] },
    preservedWorkspace: {
      branch: 'feat/free-slot',
      headSha: 'abc1234',
      detachedAt: '2026-09-05T10:04:00.000Z',
    },
  });
  assert.equal(isGateParkInFlightOrFreed({ park }), true);
  assert.equal(gateParkView(runWith(park))?.slotState, 'partial-needs-restore');
});

test('a park still in flight is still reported as still landing', () => {
  // The distinction only earns its keep if a genuinely in-flight park keeps the
  // wait-for-it copy.
  const view = gateParkView(
    runWith(parkRecord({ slotDisposition: 'freed', phase: 'resources-stopping' })),
  );
  assert.equal(view?.slotState, 'freeing');
  const notice = gateParkGateNotice(view);
  assert.equal(notice?.kind, 'park-in-flight');
  assert.equal(notice?.blocking, true);
  assert.match(notice.message, /still landing/u);
});

test('a Gateway verdict of available supersedes a refusal from an earlier attempt', () => {
  const park = parkRecord({
    slotDisposition: 'freed',
    slotFreedAt: '2026-09-05T10:05:00.000Z',
    restoreRefusal: {
      code: MachineParkEligibilityCodes.restoreSlotTaken,
      reason: 'macwork-ff-1 was running run-9',
      at: '2026-09-05T11:00:00.000Z',
    },
  });
  const notice = gateParkGateNotice(
    gateParkView(runWith(park), {
      target: { slotId: 'macwork-ff-1', disposition: 'freed', available: true },
      eligibility: { code: 'ELIGIBLE_FREED_SLOT_RESTORE', reason: 'the slot is free again' },
    }),
  );
  assert.equal(notice?.kind, 'restore-first');
  assert.equal(notice?.blocking, false, 'a stale refusal must not outrank a fresh verdict');
  assert.equal(notice?.refusalSuperseded, true);
  assert.equal(notice?.refusal?.code, 'RESTORE_SLOT_TAKEN');
});

test('an unread availability leaves a recorded refusal standing', () => {
  const park = parkRecord({
    slotDisposition: 'freed',
    slotFreedAt: '2026-09-05T10:05:00.000Z',
    restoreRefusal: {
      code: MachineParkEligibilityCodes.restoreSlotTaken,
      reason: 'macwork-ff-1 is now running run-9',
      at: '2026-09-05T11:00:00.000Z',
    },
  });
  const notice = gateParkGateNotice(gateParkView(runWith(park)));
  assert.equal(notice?.kind, 'restore-blocked');
  assert.equal(notice?.blocking, true);
  assert.equal(notice?.refusalSuperseded, undefined);
  assert.match(notice.message, /Nothing has re-checked that slot since/u);
});
