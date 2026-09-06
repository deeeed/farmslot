import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runtimePostureApply,
  runtimePosturePreview,
  runtimePostureStatus,
} from './runtime-posture.js';

const runId = 'run-a';

test('posture RPC params are validated before reaching the run store', async () => {
  await assert.rejects(runtimePostureStatus({ runId: '  ' }), /runId must be a non-empty string/);
  await assert.rejects(
    runtimePosturePreview({ runId, posture: 'sleeping' as never }),
    /posture must be one of/,
  );
  await assert.rejects(
    runtimePosturePreview({ runId, gateChoice: 'whatever' as never }),
    /gateChoice must be one of/,
  );
  await assert.rejects(
    runtimePostureApply({ runId, operationId: '   ' }),
    /operationId must be a non-empty string/,
  );
});

test('malformed proof requirements are rejected field by field', async () => {
  const cases: Array<[unknown, RegExp]> = [
    ['not-an-array', /proofRequirements must be an array/],
    [[null], /proofRequirements\[0\] must be an object/],
    [[{ reason: 'r', mode: 'state' }], /proofRequirements\[0\]\.capabilityId/],
    [[{ capabilityId: 'c', mode: 'state' }], /proofRequirements\[0\]\.reason/],
    [[{ capabilityId: 'c', reason: 'r', mode: 'telepathy' }], /proofRequirements\[0\]\.mode/],
    [
      [{ capabilityId: 'c', reason: 'r', mode: 'state', parameters: [] }],
      /proofRequirements\[0\]\.parameters must be an object/,
    ],
    [
      [{ capabilityId: 'c', reason: 'r', mode: 'state', parameters: 'x' }],
      /proofRequirements\[0\]\.parameters must be an object/,
    ],
  ];
  for (const [proofRequirements, expected] of cases) {
    await assert.rejects(
      runtimePosturePreview({ runId, proofRequirements: proofRequirements as never }),
      expected,
      `expected ${JSON.stringify(proofRequirements)} to be rejected`,
    );
  }
});

// ─── ADR-054 free-slot: the public apply is fenced from a park ───

test('runtime.posture.apply refuses every posture but parked on a gate-parked run', async (t) => {
  const { createRun, deleteRun, updateRun } = await import('../runs/store.js');
  const { GatewayMethodError } = await import('../core/method-error.js');
  const slotId = `posture-fence-slot-${Date.now()}`;
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-POSTURE-FENCE-${Date.now()}`,
    runner: 'claude',
    slotId,
  });
  const at = '2026-09-05T00:00:00.000Z';
  t.after(async () => {
    updateRun(run.id, { status: 'failed', park: null });
    await deleteRun(run.id);
  });
  updateRun(run.id, {
    status: 'blocked',
    park: {
      version: 1,
      operationId: 'park-posture-fence',
      previewId: 'preview-posture-fence',
      runId: run.id,
      generation: 1,
      machine: 'macwork',
      slotId,
      mode: 'release',
      phase: 'parked',
      slotDisposition: 'freed',
      slotFreedAt: '2026-09-05T00:00:10.000Z',
      prePauseStatus: 'blocked',
      prePauseCurrentStep: { index: 1, name: 'human-gate', status: 'running' },
      resourceManifest: { capturedAt: at, resources: [], capabilityLeases: [] },
      recoveryHandle: null,
      errors: [],
      residuals: { runner: 'stopped', resources: [] },
      createdAt: at,
      updatedAt: at,
    },
  });

  // `keep-for-validation` resolves to `active`, which would reacquire providers
  // on a slot another run may already own and report the worker retained.
  for (const posture of ['active', 'operator-wait', 'terminal'] as const) {
    await assert.rejects(
      runtimePostureApply({ runId: run.id, posture }),
      (error: unknown) => {
        assert.ok(error instanceof GatewayMethodError);
        assert.equal(error.code, 'FREED_SLOT_RESTORE_REQUIRED');
        return true;
      },
      `posture '${posture}' must be refused`,
    );
  }

  // `parked` stays allowed: re-applying the park it is already in is idempotent.
  // It passes the fence and reaches the reconciler, which this test does not
  // stand up — so any failure from there is fine, a fence refusal is not.
  const parkedOutcome = await runtimePostureApply({ runId: run.id, posture: 'parked' }).then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(
    parkedOutcome instanceof GatewayMethodError,
    false,
    `posture 'parked' must pass the fence, got ${(parkedOutcome as Error | null)?.message}`,
  );
});
