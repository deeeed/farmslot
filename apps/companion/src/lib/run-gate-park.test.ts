/**
 * Companion's gate-park contract, against payloads captured from the live
 * Gateway (ADR-054 `free-slot`).
 *
 * The two records below are the real `MachineParkRecord`s the dev Gateway
 * served for run `98c3657b` on `macwork-ff-2` on 2026-09-06 — first while its
 * slot was freed for dispatch, then after `machine.pause.restore` put it back.
 * A synthetic fixture proves only that the reading agrees with what a test
 * author imagined the Gateway sends; these prove it agrees with what it sends.
 *
 * `recoveryHandle` and `resourceManifest` are dropped from the captured
 * payloads because they carry machine-local filesystem paths and the reading
 * never touches either. Everything the reading does touch is verbatim.
 *
 * What is NOT proven here: the device render. Companion's tests run the library
 * layer only — no React renderer — so `RunPosturePanel` and `RunGateParkNotice`
 * are exercised through the values they are handed, not on a phone.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  gateParkGateNotice,
  gateParkStateLabel,
  gateParkSummaryLine,
  gateParkView,
  isSlotFreedByPark,
  liveGateParkView,
  type MachineParkRecord,
  type Run,
} from '@farmslot/protocol';

import { gateChoiceHelp } from './run-posture-gate';

/** Captured live: the park had stopped the worker and released the slot. */
const CAPTURED_FREED: MachineParkRecord = {
  version: 1,
  operationId: 'posture-38342581-e33a-4fb5-83e9-c03cb6a5c7f9',
  previewId: 'pause-9ceb574831586e32806a9fd6',
  runId: '98c3657b-caae-41d6-91eb-1b96447f2480',
  generation: 0,
  machine: 'macwork',
  slotId: 'macwork-ff-2',
  mode: 'release',
  phase: 'parked',
  slotDisposition: 'freed',
  preservedWorkspace: {
    branch: 'feat/manual-000121-fix-runner-stop-process-scan',
    headSha: 'e32886e217f77bac5e0688d49ae87590cbf78f6c',
    detachedAt: '2026-09-06T08:32:06.144Z',
  },
  prePauseStatus: 'blocked',
  prePauseCurrentStep: { index: 7, name: 'human-gate', status: 'running' },
  resourceManifest: { capturedAt: '2026-09-06T08:31:58.420Z', resources: [], capabilityLeases: [] },
  recoveryHandle: null,
  errors: [],
  residuals: { runner: 'stopped', resources: [] },
  createdAt: '2026-09-06T08:31:58.426Z',
  updatedAt: '2026-09-06T08:32:06.161Z',
  parkedAt: '2026-09-06T08:32:05.898Z',
  slotFreedAt: '2026-09-06T08:32:06.161Z',
};

/** Captured live: the same record after `machine.pause.restore` settled it. */
const CAPTURED_RESTORED: MachineParkRecord = {
  version: 1,
  operationId: 'machine-park-f5ff3427-140e-455f-8bdc-cd290e56edf4',
  previewId: 'restore-7868bd703aff5786efefa7aa',
  runId: '98c3657b-caae-41d6-91eb-1b96447f2480',
  generation: 0,
  machine: 'macwork',
  slotId: 'macwork-ff-2',
  mode: 'release',
  phase: 'restored',
  slotDisposition: 'freed',
  preservedWorkspace: {
    branch: 'feat/manual-000121-fix-runner-stop-process-scan',
    headSha: 'e32886e217f77bac5e0688d49ae87590cbf78f6c',
  },
  prePauseStatus: 'blocked',
  prePauseCurrentStep: { index: 7, name: 'human-gate', status: 'running' },
  resourceManifest: { capturedAt: '2026-09-06T08:31:58.420Z', resources: [], capabilityLeases: [] },
  recoveryHandle: null,
  errors: [],
  residuals: { runner: 'running', resources: [] },
  createdAt: '2026-09-06T08:31:58.426Z',
  updatedAt: '2026-09-06T08:35:04.966Z',
  parkedAt: '2026-09-06T08:32:05.898Z',
  restoreDisposition: 'effectful',
  restoreProgress: {
    operationId: 'machine-park-f5ff3427-140e-455f-8bdc-cd290e56edf4',
    completed: ['rebind', 'reattach', 'reacquire', 'reload'],
    updatedAt: '2026-09-06T08:34:53.208Z',
  },
  slotReboundAt: '2026-09-06T08:34:20.300Z',
  restoreEffects: [],
  recoveryProof: {
    sessionId: '12eb4240-de29-437b-88ff-9ba331f32899',
    live: true,
    acknowledgement: {
      kind: 'structured',
      source: 'hook-digest',
      reason: 'hook prompt digest matched on pane %1385',
      turnToken: '12eb4240-de29-437b-88ff-9ba331f32899:1788683682163',
    },
    acceptedAt: '2026-09-06T08:34:53.176Z',
  },
  restoredAt: '2026-09-06T08:35:04.960Z',
  restoredGeneration: 0,
};

function runWith(park: MachineParkRecord): Pick<Run, 'id' | 'park'> {
  return { id: park.runId, park };
}

test('the live freed record reads as a parked run whose slot went back to dispatch', () => {
  const view = liveGateParkView(runWith(CAPTURED_FREED));
  assert.ok(view);
  assert.equal(view.slotState, 'freed');
  assert.equal(view.slotDisposition, 'freed');
  assert.equal(view.freedSlotId, 'macwork-ff-2');
  assert.equal(view.preservedWorkspace?.branch, 'feat/manual-000121-fix-runner-stop-process-scan');
  assert.equal(view.restoreBeforeGateAnswer, true);
  assert.equal(isSlotFreedByPark(runWith(CAPTURED_FREED)), true);
  assert.equal(gateParkStateLabel(view), 'Parked, slot freed for dispatch');
  assert.match(gateParkSummaryLine(view), /slot macwork-ff-2/u);
  assert.match(
    gateParkSummaryLine(view),
    /branch feat\/manual-000121-fix-runner-stop-process-scan at e32886e217f77bac5e0688d49ae87590cbf78f6c \(detached\)/u,
  );
});

test('Companion never claims restore availability the Gateway did not answer', () => {
  // `machine.pause.restore` is the only thing that answers it, and Companion
  // does not call it. Reporting "not read" is the honest reading.
  assert.equal(liveGateParkView(runWith(CAPTURED_FREED))?.restoreTarget.available, null);
});

test('the gate notice on the live freed record names the slot the answer restores into', () => {
  const notice = gateParkGateNotice(liveGateParkView(runWith(CAPTURED_FREED)));
  assert.equal(notice?.kind, 'restore-first');
  assert.equal(
    notice?.message,
    'Answering this gate restores the run into macwork-ff-2 first, then resolves the decision.',
  );
  assert.equal(notice?.refusal, undefined);
});

test('the live restored record stops claiming a freed slot and stops warning the gate', () => {
  assert.equal(liveGateParkView(runWith(CAPTURED_RESTORED)), null);
  assert.equal(isSlotFreedByPark(runWith(CAPTURED_RESTORED)), false);
  assert.equal(gateParkGateNotice(liveGateParkView(runWith(CAPTURED_RESTORED))), null);

  // The settled record is still readable — Run Detail's history reads it — and
  // it reports how the worker was proven back.
  const settled = gateParkView(runWith(CAPTURED_RESTORED));
  assert.equal(settled?.slotState, 'settled');
  assert.equal(settled?.restoreBeforeGateAnswer, false);
  assert.equal(settled?.workerProof?.kind, 'structured');
  assert.equal(settled?.restoreStage.state, 'complete');
  assert.deepEqual(settled?.restoreStage.remaining, []);
});

test('the free-slot choice copy no longer says gate-held runs are ineligible', () => {
  // Slices 1 and 2 made gate-held `free-slot` real; the help text saying
  // otherwise is now the only thing that would tell an operator not to use it.
  const help = gateChoiceHelp('free-slot');
  assert.match(help, /hand its slot back to dispatch/u);
  assert.doesNotMatch(help, /not eligible/u);
});
