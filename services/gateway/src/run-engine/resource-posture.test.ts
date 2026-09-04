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
