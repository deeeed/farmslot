import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ResourcePosture,
  ResourcePostureGateChoice,
  RuntimePostureApplyResult,
} from '@farmslot/protocol';

import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';
import type {
  ResourcePostureRequest,
  RunResourcePostureReconciler,
} from '../runtime-capabilities/posture.js';

import {
  gateChoiceFromSelectionData,
  postureForBoundary,
  prepareRunPostureForValidation,
  reconcileRunPosture,
  resolveGateChoiceOutcome,
  RUN_POSTURE_BOUNDARIES,
  type RunPostureBoundary,
} from './resource-posture.js';

function fakeReconciler(
  onApply: (request: ResourcePostureRequest) => Partial<RuntimePostureApplyResult> = () => ({}),
) {
  const calls: ResourcePostureRequest[] = [];
  const reconciler = {
    apply: async (request: ResourcePostureRequest): Promise<RuntimePostureApplyResult> => {
      calls.push(request);
      const override = onApply(request);
      return {
        ok: true,
        status: {
          posture: request.posture ?? 'active',
          policySource: 'framework-default',
          capabilities: [],
          workerRetained: true,
          updatedAt: '2026-09-04T00:00:00.000Z',
        },
        transition: {
          id: 'op-1',
          posture: request.posture ?? 'active',
          policySource: 'framework-default',
          requestedAt: '2026-09-04T00:00:00.000Z',
          completedAt: '2026-09-04T00:00:00.000Z',
          outcome: 'applied',
          effects: [],
          progress: { total: 0, completed: 0 },
          failures: [],
        },
        ...override,
      } as RuntimePostureApplyResult;
    },
  } as unknown as RunResourcePostureReconciler;
  return { reconciler, calls };
}

const createdRunIds: string[] = [];

function newRun(): string {
  const id = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'test-project',
    ticketOrPr: 'MANUAL-1',
  }).id;
  createdRunIds.push(id);
  return id;
}

test.after(async () => {
  for (const runId of createdRunIds) {
    if (!getRun(runId)) continue;
    updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(runId);
  }
});

test('every lifecycle boundary maps to a semantic posture, not a step name', () => {
  const expected: Record<RunPostureBoundary, ResourcePosture> = {
    'operator-wait': 'operator-wait',
    'gate-resolved': 'operator-wait',
    'validation-prepare': 'active',
    cancel: 'terminal',
    'family-terminal': 'terminal',
  };
  for (const boundary of RUN_POSTURE_BOUNDARIES) {
    assert.equal(postureForBoundary(boundary), expected[boundary]);
  }
});

test('durable waits, validation, cancel, and family terminal reach the reconciler as postures', async () => {
  const { reconciler, calls } = fakeReconciler();
  const runId = newRun();
  for (const boundary of RUN_POSTURE_BOUNDARIES) {
    await reconcileRunPosture({ runId, boundary }, reconciler);
  }
  assert.deepEqual(
    calls.map((call) => call.posture),
    ['operator-wait', 'operator-wait', 'active', 'terminal', 'terminal'],
  );
});

test('a resolved gate carries the operator choice into the wait that follows', async () => {
  const { reconciler, calls } = fakeReconciler();
  const runId = newRun();
  await reconcileRunPosture(
    { runId, boundary: 'gate-resolved', gateChoice: 'keep-for-validation' },
    reconciler,
  );
  assert.equal(calls[0].gateChoice, 'keep-for-validation');

  // The reconciler persists the choice; the next wait of the same run inherits it.
  updateRun(runId, {
    resourcePosture: {
      posture: 'active',
      policySource: 'gate-choice',
      gateChoice: 'keep-for-validation',
      capabilities: [],
      workerRetained: true,
      updatedAt: '2026-09-04T00:00:00.000Z',
    },
  });
  await reconcileRunPosture({ runId, boundary: 'operator-wait' }, reconciler);
  assert.equal(calls[1].gateChoice, 'keep-for-validation');

  // A terminal boundary is a fact about the run ending, not an operator preference.
  await reconcileRunPosture({ runId, boundary: 'family-terminal' }, reconciler);
  assert.equal(calls[2].gateChoice, undefined);
  assert.equal(calls[2].posture, 'terminal');
});

test('a reconcile failure never breaks the boundary and is persisted, not swallowed', async () => {
  const recorded: Array<{ runId: string; posture: ResourcePosture; reason: string }> = [];
  const throwing = {
    apply: async () => {
      throw new Error('capability catalog unavailable');
    },
    recordFailure: async (runId: string, posture: ResourcePosture, reason: string) => {
      recorded.push({ runId, posture, reason });
      return null;
    },
  } as unknown as RunResourcePostureReconciler;
  const runId = newRun();
  const outcome = await reconcileRunPosture({ runId, boundary: 'operator-wait' }, throwing);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'capability catalog unavailable');
  // The failure reaches persisted posture status, not just a log line.
  assert.deepEqual(recorded, [
    { runId, posture: 'operator-wait', reason: 'capability catalog unavailable' },
  ]);
});

test('a failure while recording a failure still lets the boundary finish', async () => {
  const throwing = {
    apply: async () => {
      throw new Error('catalog unavailable');
    },
    recordFailure: async () => {
      throw new Error('run store unavailable');
    },
  } as unknown as RunResourcePostureReconciler;
  const outcome = await reconcileRunPosture({ runId: newRun(), boundary: 'cancel' }, throwing);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'catalog unavailable');
});

test('validation preparation reports a typed blocking reason instead of running', async () => {
  const runId = newRun();
  const { reconciler } = fakeReconciler(() => ({
    ok: false,
    transition: {
      id: 'op-1',
      posture: 'active',
      policySource: 'framework-default',
      requestedAt: '2026-09-04T00:00:00.000Z',
      completedAt: '2026-09-04T00:00:00.000Z',
      outcome: 'rejected',
      effects: [],
      progress: { total: 1, completed: 0 },
      failures: [],
      rejection: {
        kind: 'capability-unavailable',
        capabilityId: 'browser-cdp',
        reason: "Exclusive capability 'browser-cdp' is owned by run-b",
        conflict: {
          kind: 'lease-conflict',
          capabilityId: 'browser-cdp',
          owner: { runId: 'run-b' },
          leaseId: 'lease-9',
          reason: "Exclusive capability 'browser-cdp' is owned by run-b",
        },
      },
    },
  }));
  const blocked = await prepareRunPostureForValidation(runId, undefined, reconciler);
  assert.equal(blocked.ok, false);
  assert.match(blocked.ok === false ? blocked.reason : '', /browser-cdp.*owned by run-b/);

  const { reconciler: healthy } = fakeReconciler();
  assert.deepEqual(await prepareRunPostureForValidation(runId, undefined, healthy), { ok: true });
});

test('only the typed gate-choice vocabulary is read out of selectionData', () => {
  assert.equal(gateChoiceFromSelectionData({ resourcePosture: 'minimize' }), 'minimize');
  assert.equal(gateChoiceFromSelectionData({ resourcePosture: 'terminal' }), undefined);
  assert.equal(gateChoiceFromSelectionData({ resourcePosture: 42 }), undefined);
  assert.equal(gateChoiceFromSelectionData(undefined), undefined);
  const choice: ResourcePostureGateChoice | undefined = gateChoiceFromSelectionData({
    resourcePosture: 'project-default',
  });
  assert.equal(choice, 'project-default');
});

function outcomeWithRejection(rejection: Record<string, unknown> | undefined) {
  return {
    ok: !rejection,
    result: {
      ok: !rejection,
      status: {
        posture: 'operator-wait' as const,
        policySource: 'framework-default' as const,
        capabilities: [],
        workerRetained: true,
        updatedAt: '2026-09-05T00:00:00.000Z',
      },
      transition: {
        id: 'op-1',
        posture: 'parked' as const,
        policySource: 'gate-choice' as const,
        requestedAt: '2026-09-05T00:00:00.000Z',
        completedAt: '2026-09-05T00:00:00.000Z',
        outcome: rejection ? ('rejected' as const) : ('applied' as const),
        effects: [],
        progress: { total: 0, completed: 0 },
        failures: [],
        ...(rejection ? { rejection } : {}),
      },
    },
  } as unknown as Parameters<typeof resolveGateChoiceOutcome>[0];
}

test('a resolved gate choice reports applied, rejected, or unavailable', () => {
  assert.deepEqual(resolveGateChoiceOutcome(outcomeWithRejection(undefined)), { kind: 'applied' });

  assert.deepEqual(
    resolveGateChoiceOutcome(
      outcomeWithRejection({
        kind: 'park-ineligible',
        code: 'STATUS_NOT_ELIGIBLE',
        reason: "status 'human-gating' is not monitoring or ci-watching",
      }),
    ),
    {
      kind: 'rejected',
      code: 'STATUS_NOT_ELIGIBLE',
      reason: "status 'human-gating' is not monitoring or ci-watching",
    },
  );

  // A capability rejection has no eligibility code.
  assert.deepEqual(
    resolveGateChoiceOutcome(
      outcomeWithRejection({
        kind: 'capability-unavailable',
        capabilityId: 'browser-cdp',
        reason: 'owned by run-b',
        conflict: {},
      }),
    ),
    { kind: 'rejected', reason: 'owned by run-b' },
  );

  assert.deepEqual(resolveGateChoiceOutcome({ ok: false, error: 'catalog unavailable' }), {
    kind: 'unavailable',
    reason: 'catalog unavailable',
  });

  // The secondary failure is carried, not dropped.
  assert.deepEqual(
    resolveGateChoiceOutcome({
      ok: false,
      error: 'catalog unavailable',
      recordFailureError: 'run store unavailable',
    }),
    {
      kind: 'unavailable',
      reason: 'catalog unavailable (and the failure could not be persisted: run store unavailable)',
    },
  );
});

test('a failure of the failure recorder is named and returned, never dropped', async () => {
  const throwing = {
    apply: async () => {
      throw new Error('catalog unavailable');
    },
    recordFailure: async () => {
      throw new Error('run store unavailable');
    },
  } as unknown as RunResourcePostureReconciler;
  const outcome = await reconcileRunPosture({ runId: newRun(), boundary: 'cancel' }, throwing);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'catalog unavailable');
  assert.equal(
    outcome.result === undefined ? outcome.recordFailureError : undefined,
    'run store unavailable',
  );
});

// ─── ADR-054 free-slot: a park in flight owns the run's posture ───

const GATE_PARK_RECORD = {
  version: 1,
  operationId: 'op',
  previewId: 'preview',
  generation: 1,
  machine: 'macwork',
  slotId: 'slot-a',
  mode: 'release',
  phase: 'resources-stopping',
  slotDisposition: 'freed',
  prePauseStatus: 'blocked',
  prePauseCurrentStep: { index: 1, name: 'human-gate', status: 'running' },
  resourceManifest: { capturedAt: 'x', resources: [], capabilityLeases: [] },
  recoveryHandle: null,
  errors: [],
  residuals: { runner: 'stopped', resources: [] },
  createdAt: 'x',
  updatedAt: 'x',
} as const;

test('a wait boundary does not act while a gate park is in flight', async () => {
  const { reconciler, calls } = fakeReconciler();
  const runId = newRun();
  updateRun(runId, { park: { ...GATE_PARK_RECORD, runId } as never });

  // Engine boundaries do not carry the public RPC's admission check, so without
  // this guard a boundary reached mid-park acts on a slot the park is releasing.
  const outcome = await reconcileRunPosture({ runId, boundary: 'operator-wait' }, reconciler);

  assert.equal(calls.length, 0);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? '', /gate park is in flight/);

  // Non-wait boundaries are untouched: cancel still has to tear the run down.
  await reconcileRunPosture({ runId, boundary: 'cancel' }, reconciler);
  assert.deepEqual(
    calls.map((call) => call.posture),
    ['terminal'],
  );
});

test('a restored gate does not inherit the free-slot choice that parked the run', async () => {
  const { reconciler, calls } = fakeReconciler();
  const runId = newRun();
  updateRun(runId, {
    resourcePosture: {
      posture: 'parked',
      policySource: 'gate-choice',
      gateChoice: 'free-slot',
      gateChoiceSuppressedUntilNextWait: true,
      capabilities: [],
      workerRetained: false,
      updatedAt: '2026-09-05T00:00:00.000Z',
    },
  });

  // The wait the restore re-presents must NOT carry `free-slot`, or the run
  // parks itself again before the operator ever sees the gate.
  await reconcileRunPosture({ runId, boundary: 'operator-wait' }, reconciler);
  assert.equal(calls[0].gateChoice, undefined);

  // One-shot: consumed, so the operator's next choice governs normally.
  assert.equal(getRun(runId)!.resourcePosture?.gateChoiceSuppressedUntilNextWait, undefined);
  assert.equal(getRun(runId)!.resourcePosture?.gateChoice, 'free-slot');

  // An EXPLICIT choice still wins over the suppression.
  updateRun(runId, {
    resourcePosture: {
      ...getRun(runId)!.resourcePosture!,
      gateChoiceSuppressedUntilNextWait: true,
    },
  });
  await reconcileRunPosture(
    { runId, boundary: 'operator-wait', gateChoice: 'free-slot' },
    reconciler,
  );
  assert.equal(calls[1].gateChoice, 'free-slot');
});
