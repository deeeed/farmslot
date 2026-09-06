import assert from 'node:assert/strict';
import test from 'node:test';

import { nothing } from 'lit';

import {
  gateParkView,
  MachineParkEligibilityCodes,
  type MachineParkRecord,
  type Run,
} from '@farmslot/protocol';

import {
  gateChoiceHelp,
  gateParkForDecision,
  renderRunGateParkNotice,
  renderRunPostureGateChoices,
} from './run-detail-posture-gate-renderers.js';
import { renderRunGatePark, renderRunPostureSummary } from './run-detail-posture-renderers.js';

/**
 * Flatten a lit template into the text and attribute values it would render.
 *
 * The renderers are asserted on their OUTPUT rather than on "is not `nothing`":
 * a panel that renders but omits the freed slot passes the weaker check, and
 * omitting the freed slot is precisely the failure these surfaces exist to
 * prevent.
 */
function templateText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(templateText).join('');
  const result = value as { strings?: readonly string[]; values?: readonly unknown[] };
  if (!result.strings) return '';
  const values = result.values ?? [];
  return result.strings.reduce<string>(
    (text, chunk, index) =>
      text + chunk + (index < values.length ? templateText(values[index]) : ''),
    '',
  );
}

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

const FREED_PARK = parkRecord({
  slotDisposition: 'freed',
  slotFreedAt: '2026-09-05T10:05:00.000Z',
  preservedWorkspace: {
    branch: 'feat/free-slot',
    headSha: 'abc1234',
    detachedAt: '2026-09-05T10:04:00.000Z',
  },
});

test('a run with no park record renders no gate park block', () => {
  assert.equal(renderRunGatePark(null), nothing);
  assert.equal(gateParkForDecision(runWith(null)), null);
  assert.equal(gateParkForDecision(null), null);
});

test('the posture panel names the parked state, the freed slot, the branch, and the target', () => {
  const text = templateText(
    renderRunPostureSummary({ status: 'idle' }, {}, gateParkView(runWith(FREED_PARK))),
  );

  assert.match(text, /Parked, slot freed for dispatch/u);
  assert.match(text, /macwork-ff-1 is free for dispatch while this run stays parked/u);
  assert.match(text, /branch feat\/free-slot at abc1234/u);
  assert.match(text, /Restore target macwork-ff-1/u);
  // Nothing read availability, so the panel says so rather than claiming free.
  assert.match(text, /availability not read/u);
  assert.match(text, /data-restore-available=unknown/u);
  assert.match(text, /data-slot-state=freed/u);
  // And an unread posture read is reported as unread, not as unavailable.
  assert.match(text, /Posture status has not been read/u);
  assert.doesNotMatch(text, /Posture status is unavailable/u);
});

test('a run with neither posture nor park renders nothing at all', () => {
  assert.equal(renderRunPostureSummary({ status: 'idle' }), nothing);
});

test('a park survives a failed posture read', () => {
  const text = templateText(
    renderRunPostureSummary(
      { status: 'error', message: 'gateway said no' },
      {},
      gateParkView(runWith(FREED_PARK)),
    ),
  );
  assert.match(text, /gateway said no/u);
  assert.match(text, /Parked, slot freed for dispatch/u);
});

test('a Gateway availability verdict is rendered as the Gateway stated it', () => {
  const text = templateText(
    renderRunGatePark(
      gateParkView(runWith(FREED_PARK), {
        target: { slotId: 'macwork-ff-1', disposition: 'freed', available: false },
        eligibility: {
          code: MachineParkEligibilityCodes.restoreSlotTaken,
          reason: 'macwork-ff-1 is now running run-9',
        },
      }),
    ),
  );
  assert.match(text, /Restore target macwork-ff-1/u);
  assert.match(text, /not available: macwork-ff-1 is now running run-9/u);
  assert.match(text, /data-restore-available=false/u);
});

test('the gate says answering restores the run into its slot first', () => {
  const text = templateText(renderRunGateParkNotice(gateParkView(runWith(FREED_PARK))));
  assert.match(
    text,
    /Answering this gate restores the run into macwork-ff-1 first, then resolves the decision\./u,
  );
  assert.match(text, /data-kind=restore-first/u);
  assert.match(text, /Parked, slot freed for dispatch/u);
});

test('a refused restore blocks the answer and shows the typed refusal', () => {
  const park = parkRecord({
    slotDisposition: 'freed',
    slotFreedAt: '2026-09-05T10:05:00.000Z',
    restoreRefusal: {
      code: MachineParkEligibilityCodes.restoreSlotTaken,
      reason: 'macwork-ff-1 is now running run-9',
      at: '2026-09-05T11:00:00.000Z',
    },
  });
  const text = templateText(renderRunGateParkNotice(gateParkView(runWith(park))));
  assert.match(text, /data-kind=restore-blocked/u);
  assert.match(text, /Last restore refused \(RESTORE_SLOT_TAKEN\): macwork-ff-1 is now running/u);
  assert.match(text, /role=alert/u);
});

test('a park still landing says the gate cannot be answered yet', () => {
  const park = parkRecord({ slotDisposition: 'freed', phase: 'runner-stopping' });
  const text = templateText(renderRunGateParkNotice(gateParkView(runWith(park))));
  assert.match(text, /data-kind=park-in-flight/u);
  assert.match(text, /cannot be answered yet/u);
});

test('a retained park and a settled one add no gate notice', () => {
  assert.equal(renderRunGateParkNotice(gateParkView(runWith(parkRecord()))), nothing);
  assert.equal(
    renderRunGateParkNotice(
      gateParkView(runWith(parkRecord({ slotDisposition: 'freed', phase: 'restored' }))),
    ),
    nothing,
  );
  // A settled record is not a live gate park at all.
  assert.equal(
    gateParkForDecision(runWith(parkRecord({ slotDisposition: 'freed', phase: 'restored' }))),
    null,
  );
});

test('the park notice renders even though a parked run hides the gate choices', () => {
  // A `free-slot` park moves the run's posture to `parked`, which is exactly
  // when `postureChoicesApply` hides the choices. The notice must survive that
  // or the operator answers a parked gate with no warning at all.
  const text = templateText(
    renderRunPostureGateChoices({
      state: { choice: null, status: 'idle', runPosture: 'parked' },
      disabled: false,
      onSelect: () => {},
      run: runWith(FREED_PARK),
    }),
  );
  assert.match(text, /Answering this gate restores the run into macwork-ff-1 first/u);
  assert.doesNotMatch(text, /Resource posture for this wait/u);
});

test('the notice renders inside the choices panel while the run is at an operator wait', () => {
  const text = templateText(
    renderRunPostureGateChoices({
      state: { choice: null, status: 'idle', runPosture: 'operator-wait' },
      disabled: false,
      onSelect: () => {},
      run: runWith(FREED_PARK),
    }),
  );
  assert.match(text, /Resource posture for this wait/u);
  assert.match(text, /Answering this gate restores the run into macwork-ff-1 first/u);
});

test('free-slot help no longer claims gate-held runs are ineligible', () => {
  const help = gateChoiceHelp('free-slot');
  assert.match(help, /hand its slot back to dispatch/u);
  assert.doesNotMatch(help, /not eligible/u);
});
