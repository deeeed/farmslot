/**
 * The only place that maps run-engine lifecycle boundaries to ADR-054 postures.
 *
 * Call sites name the *boundary they reached* — a durable operator wait, a
 * resolved gate, validation preparation, a cancel, a family terminal. They never
 * name a posture, a step, a runner, or a project. That keeps flows with
 * different step orders (MONITOR hold, HUMAN_GATE, CI watch) behaving the same.
 */
import {
  isResourcePostureGateChoice,
  type ResourcePosture,
  type ResourcePostureGateChoice,
  type RuntimeCapabilityProofRequirement,
  type RuntimePostureApplyResult,
} from '@farmslot/protocol';

import { getRunResourcePostureReconciler } from '../methods/runtime-posture.js';
import { getRun } from '../runs/store.js';
import type { RunResourcePostureReconciler } from '../runtime-capabilities/posture.js';

export const RUN_POSTURE_BOUNDARIES = [
  /** The run parked itself on an operator or on CI and will not progress alone. */
  'operator-wait',
  /** An operator just resolved a gate; their choice governs the wait that follows. */
  'gate-resolved',
  /** A validation action or recipe rerun is about to run and needs its proof plan. */
  'validation-prepare',
  /** The run was cancelled. */
  'cancel',
  /** The run family is finished with the slot. */
  'family-terminal',
] as const;

export type RunPostureBoundary = (typeof RUN_POSTURE_BOUNDARIES)[number];

const BOUNDARY_POSTURE: Record<RunPostureBoundary, ResourcePosture> = {
  'operator-wait': 'operator-wait',
  // A resolved gate is still a wait until the choice says otherwise; the choice
  // is what can promote it to `active` or `parked`.
  'gate-resolved': 'operator-wait',
  'validation-prepare': 'active',
  cancel: 'terminal',
  'family-terminal': 'terminal',
};

export function postureForBoundary(boundary: RunPostureBoundary): ResourcePosture {
  return BOUNDARY_POSTURE[boundary];
}

/** Reads the typed gate choice a client sent with `run.resolveDecision`. */
export function gateChoiceFromSelectionData(
  selectionData: Record<string, unknown> | undefined,
): ResourcePostureGateChoice | undefined {
  const value = selectionData?.resourcePosture;
  return isResourcePostureGateChoice(value) ? value : undefined;
}

export interface ReconcileRunPostureRequest {
  runId: string;
  boundary: RunPostureBoundary;
  gateChoice?: ResourcePostureGateChoice;
  /** Overrides the registry's stored proof plan (validation re-applies its own). */
  proofRequirements?: RuntimeCapabilityProofRequirement[];
  operationId?: string;
}

function isWaitBoundary(boundary: RunPostureBoundary): boolean {
  return boundary === 'operator-wait' || boundary === 'gate-resolved';
}

/**
 * Reconcile one boundary. Never throws: a lifecycle boundary must not lose the
 * operator hold, the cancel, or the slot teardown it is attached to because a
 * provider or the project catalog was unreachable. The failure is not
 * discarded — it is persisted on the run as a posture transition failure that
 * clients render, and logged here.
 */
export async function reconcileRunPosture(
  request: ReconcileRunPostureRequest,
  reconciler: RunResourcePostureReconciler = getRunResourcePostureReconciler(),
): Promise<RunPostureReconcileOutcome> {
  const posture = postureForBoundary(request.boundary);
  // The operator's choice for the wait they just ended also governs the wait
  // that follows it (a gate resolving into a CI watch is one operator decision).
  const carried = isWaitBoundary(request.boundary)
    ? (request.gateChoice ?? getRun(request.runId)?.resourcePosture?.gateChoice)
    : request.gateChoice;
  try {
    const result = await reconciler.apply({
      runId: request.runId,
      posture,
      ...(carried ? { gateChoice: carried } : {}),
      ...(request.proofRequirements ? { proofRequirements: request.proofRequirements } : {}),
      ...(request.operationId ? { operationId: request.operationId } : {}),
    });
    return { ok: result.ok, result };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `[run-engine] posture reconcile for ${request.runId.slice(0, 8)} at boundary ` +
        `'${request.boundary}' failed: ${detail}`,
    );
    // Not swallowed: the failure becomes a durable `failed` transition on the
    // run so posture status and reconnecting clients see it. The boundary itself
    // must still complete — losing an operator hold, a cancel, or a slot
    // teardown because a provider was unreachable would be the worse outcome.
    let recordFailureError: string | undefined;
    try {
      await reconciler.recordFailure(request.runId, posture, detail, request.operationId);
    } catch (recordError) {
      // A secondary failure of the recorder itself is NOT discarded: it is named,
      // logged with both reasons, and returned to the caller so the boundary can
      // surface it. Rethrowing here is what would be wrong — this catch exists
      // only because the alternative is dropping the operator hold, the cancel,
      // or the slot teardown this reconcile is attached to. Callers that can
      // safely fail (the RPC path) go through `apply`, which never routes here.
      recordFailureError = recordError instanceof Error ? recordError.message : String(recordError);
      console.error(
        `[run-engine] posture failure for ${request.runId.slice(0, 8)} could not be persisted: ` +
          `reconcile failed with "${detail}" and recording that failed with ` +
          `"${recordFailureError}"`,
      );
    }
    return {
      ok: false,
      error: detail,
      ...(recordFailureError ? { recordFailureError } : {}),
    };
  }
}

export type RunPostureReconcileOutcome =
  | { ok: boolean; result: RuntimePostureApplyResult; error?: undefined }
  | {
      ok: false;
      result?: undefined;
      error: string;
      /** Set when the failure could not even be written to the run's posture. */
      recordFailureError?: string;
    };

export type GateChoiceOutcome =
  | { kind: 'applied' }
  | { kind: 'rejected'; code?: string; reason: string }
  | { kind: 'unavailable'; reason: string };

/**
 * What a resolved gate choice actually did. Pure so the gate's branch is
 * testable without standing up a whole publication gate.
 *
 * A rejection is already durable on the run (the reconciler rolled the posture
 * back and recorded a `rejected` transition), so the caller must NOT reconcile
 * again to "restore" anything: a second apply would overwrite that transition
 * with an `applied` one and erase the only record the operator has.
 */
export function resolveGateChoiceOutcome(outcome: RunPostureReconcileOutcome): GateChoiceOutcome {
  if (outcome.error !== undefined) {
    return {
      kind: 'unavailable',
      reason: outcome.recordFailureError
        ? `${outcome.error} (and the failure could not be persisted: ${outcome.recordFailureError})`
        : outcome.error,
    };
  }
  const rejection = outcome.result.transition.rejection;
  if (!rejection) return { kind: 'applied' };
  return {
    kind: 'rejected',
    ...('code' in rejection && rejection.code ? { code: rejection.code } : {}),
    reason: rejection.reason,
  };
}

/**
 * Validation preparation is `active` with the action's proof plan re-applied.
 * Returns the blocking reason when a required capability cannot be acquired, so
 * the caller can refuse the action before it touches the slot.
 */
export async function prepareRunPostureForValidation(
  runId: string,
  proofRequirements?: RuntimeCapabilityProofRequirement[],
  reconciler?: RunResourcePostureReconciler,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const outcome = await reconcileRunPosture(
    {
      runId,
      boundary: 'validation-prepare',
      ...(proofRequirements ? { proofRequirements } : {}),
    },
    reconciler,
  );
  if (outcome.error !== undefined) return { ok: false, reason: outcome.error };
  const rejection = outcome.result.transition.rejection;
  if (rejection) {
    return {
      ok: false,
      reason:
        rejection.kind === 'capability-unavailable'
          ? `runtime capability '${rejection.capabilityId}' is unavailable: ${rejection.reason}`
          : rejection.reason,
    };
  }
  const failures = outcome.result.transition.failures;
  if (failures.length > 0) {
    return {
      ok: false,
      reason: failures.map((failure) => `${failure.capabilityId}: ${failure.reason}`).join('; '),
    };
  }
  return { ok: true };
}
