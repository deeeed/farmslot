/**
 * Gate-park records the tests share (ADR-054 `free-slot`).
 *
 * The two `CAPTURED_*` records are the real `MachineParkRecord`s the dev
 * Gateway served for run `98c3657b` on `macwork-ff-2` on 2026-09-06 — first
 * while its slot was freed for dispatch, then after `machine.pause.restore` put
 * it back. A synthetic fixture proves only that the reading agrees with what a
 * test author imagined the Gateway sends; these prove it agrees with what it
 * sends.
 *
 * `recoveryHandle` and `resourceManifest` are dropped from the captured
 * payloads because they carry machine-local filesystem paths and nothing in the
 * reading touches either. Every field the reading does touch is verbatim.
 *
 * The `PARTIAL_*` records are derived rather than captured: a park that fails
 * partway is not something a healthy fleet produces on demand. They are built
 * from the captured record so only the failure differs from a real payload.
 *
 * Nothing in the app imports this module, so it is test-only and never bundled.
 */
import type { MachineParkRecord } from '@farmslot/protocol';

/** Captured live: the park had stopped the worker and released the slot. */
export const CAPTURED_FREED: MachineParkRecord = {
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
export const CAPTURED_RESTORED: MachineParkRecord = {
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

/** The freed record after a restore attempt found the slot taken. */
export const CAPTURED_FREED_REFUSED: MachineParkRecord = {
  ...CAPTURED_FREED,
  restoreRefusal: {
    code: 'RESTORE_SLOT_TAKEN',
    reason: 'macwork-ff-2 is now running run-9',
    at: '2026-09-06T08:33:00.000Z',
  },
};

/**
 * Derived: a park that failed during resource stop, before it touched the
 * runner and before any detach. Its worker is observably alive, so the Gateway
 * leaves the gate answerable where it stands.
 */
export const PARTIAL_ANSWERABLE: MachineParkRecord = {
  ...CAPTURED_FREED,
  phase: 'partial',
  residuals: { runner: 'running', resources: [] },
  preservedWorkspace: {
    branch: CAPTURED_FREED.preservedWorkspace!.branch,
    headSha: CAPTURED_FREED.preservedWorkspace!.headSha,
  },
  slotFreedAt: undefined,
  errors: [
    {
      phase: 'partial',
      action: 'resource-stop',
      code: 'HOOK_FAILED',
      message: 'the dev server would not stop',
      occurredAt: '2026-09-06T08:32:02.000Z',
      retryable: true,
    },
  ],
};

/**
 * Derived: the same failure, but the worker was stopped before it hit. Nothing
 * can act on a gate answer until a restore brings the worker back.
 */
export const PARTIAL_NEEDS_RESTORE: MachineParkRecord = {
  ...PARTIAL_ANSWERABLE,
  residuals: { runner: 'stopped', resources: [] },
};

/** The Gateway verdicts a `machine.pause.restore` preview returns. */
export const AVAILABLE_VERDICT = {
  target: { slotId: 'macwork-ff-2', disposition: 'freed' as const, available: true },
  eligibility: {
    code: 'ELIGIBLE_FREED_SLOT_RESTORE',
    reason: 'The freed slot is still free and the persisted runner session is reloadable in place.',
  },
};

export const TAKEN_VERDICT = {
  target: { slotId: 'macwork-ff-2', disposition: 'freed' as const, available: false },
  eligibility: { code: 'RESTORE_SLOT_TAKEN', reason: 'macwork-ff-2 is now running run-9' },
};
