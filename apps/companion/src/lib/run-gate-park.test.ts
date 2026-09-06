/**
 * Companion's gate-park contract, against payloads captured from the live
 * Gateway (ADR-054 `free-slot`).
 *
 * The records come from `run-gate-park.fixtures`, which holds payloads captured
 * from the live dev Gateway rather than synthesized ones.
 *
 * What is NOT proven here: that any of it reaches the screen. That is
 * `run-gate-park-render.test.ts`, which renders the real components.
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

import {
  CAPTURED_FREED,
  CAPTURED_RESTORED,
  PARTIAL_ANSWERABLE,
  PARTIAL_NEEDS_RESTORE,
} from './run-gate-park.fixtures';
import { gateChoiceHelp } from './run-posture-gate';

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

test('a partial park is read the way the Gateway fence reads it', () => {
  // The blocking regression this suite missed: every partial was labeled "still
  // landing" and its gate reported unanswerable, including the one the Gateway
  // accepts.
  const answerable = liveGateParkView({ id: PARTIAL_ANSWERABLE.runId, park: PARTIAL_ANSWERABLE });
  assert.equal(answerable?.slotState, 'partial-answerable');
  assert.equal(answerable?.restoreBeforeGateAnswer, false);
  assert.equal(gateParkGateNotice(answerable)?.blocking, false);

  const fenced = liveGateParkView({
    id: PARTIAL_NEEDS_RESTORE.runId,
    park: PARTIAL_NEEDS_RESTORE,
  });
  assert.equal(fenced?.slotState, 'partial-needs-restore');
  assert.equal(gateParkGateNotice(fenced)?.blocking, true);
});
