import {
  Events,
  isGateParkInFlightOrFreed,
  isHeldForResultDecision,
  type Principal,
  type Run,
  type RunExtendReviewBudgetParams,
  type RunExtendReviewBudgetResult,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../../core/method-error.js';
import { readSlotRow, updateSlotStatusIf } from '../../core/state.js';
import {
  extendReviewRoundBudget,
  reviewBudgetExtensionRefusal,
} from '../../review/review-round-budget.js';
import { publicationStatusForRun } from '../../run-completion/orchestrator.js';
import {
  capturePublicationSource,
  rebindUnownedPublicationSlot,
} from '../../run-completion/publication-source.js';
import {
  hasEngineDecisionWaiter,
  recordDecisionResolution,
  resolveEngineDecision,
} from '../../run-engine/engine-decisions.js';
import { requiresPublicationApproval } from '../../run-engine/publication-policy.js';
import { withRunTransition } from '../../run-lifecycle/transition-coordinator.js';
import { getRun, updateRun } from '../../runs/store.js';

export interface ReviewBudgetExtensionDependencies {
  authorize?: () => Principal;
  source?: typeof capturePublicationSource;
  rebindSlot?: typeof rebindUnownedPublicationSlot;
}

function identity(run: Run): string {
  return JSON.stringify([
    run.project,
    run.branch,
    run.slotId,
    run.archivedAt,
    run.engineState?.generation ?? 0,
    publicationStatusForRun(run),
    isGateParkInFlightOrFreed(run),
  ]);
}

/** A refused grant leaves the named slot as it found it, unless something else claimed it since. */
async function unbindNamedSlot(
  runId: string,
  slotId: string,
  before: Readonly<Record<string, unknown>> | null,
): Promise<void> {
  if (getRun(runId)?.slotId === slotId) updateRun(runId, { slotId: null });
  const bound = await readSlotRow(slotId);
  if (!before || bound?.current_run_id !== runId) return;
  const run = getRun(runId);
  if (!run) return;
  const { slotOwnershipFieldsForRun } = await import('../fleet.js');
  const written = Object.keys({
    ...slotOwnershipFieldsForRun(run),
    handoff_run_id: null,
    dispatchable: false,
  });
  await updateSlotStatusIf(
    slotId,
    (slot) => slot.current_run_id === runId && slot.slot_epoch === bound.slot_epoch,
    Object.fromEntries(written.map((key) => [key, before[key] ?? null])),
  );
}

export async function runExtendReviewBudget(
  params: RunExtendReviewBudgetParams,
  emit: (event: string, payload: unknown) => void,
  dependencies: ReviewBudgetExtensionDependencies = {},
): Promise<RunExtendReviewBudgetResult> {
  const authorize = dependencies.authorize;
  if (!authorize)
    throw new GatewayMethodError(
      'AUTH_REQUIRED',
      'Review budget extension requires an authenticated admin',
    );
  const principal = authorize();
  if (
    principal.subject.type === 'node' ||
    !principal.roles.some((entry) => entry.role === 'admin' && entry.scope.kind === 'global')
  )
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Review budget extension requires an authenticated admin',
    );
  if (
    typeof params.requestId !== 'string' ||
    !params.requestId.trim() ||
    params.requestId.length > 128 ||
    typeof params.scopeBrief !== 'string' ||
    !params.scopeBrief.trim() ||
    params.scopeBrief.length > 8192 ||
    typeof params.headSha !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(params.headSha) ||
    !Number.isSafeInteger(params.expectedLimit)
  )
    throw new Error(
      'Invalid review budget request: supply an idempotency key, full head, expected limit and scoped brief',
    );
  if (params.slotId !== undefined && (typeof params.slotId !== 'string' || !params.slotId.trim()))
    throw new Error('Invalid review budget request: a named slot must be a slot id');
  const { slotId: namedSlot, ...grant } = params;
  const request = {
    ...grant,
    headSha: params.headSha.toLowerCase(),
    scopeBrief: params.scopeBrief.trim(),
  };
  const extended = await withRunTransition(params.runId, async () => {
    const run = getRun(params.runId);
    if (!run) throw new Error(`Run not found: ${params.runId}`);
    // A released slot also clears run.slotId; the operator names the slot that still holds the
    // run branch at the approved head, and the same unowned-slot guards re-bind it.
    const naming = namedSlot !== undefined && run.slotId !== namedSlot;
    if (naming && (run.slotId || run.status !== 'failed'))
      throw new Error(
        'Review budget extension names a slot only for a failed run that lost its slot',
      );
    const expected = identity(naming ? { ...run, slotId: namedSlot } : run);
    const actor = JSON.stringify(principal);
    let slotEpoch: number | undefined;
    let bound: { slotId: string; before: Readonly<Record<string, unknown>> | null } | undefined;
    const bindNamedSlot = async (current: Run): Promise<Run> => {
      const slotId = namedSlot!;
      const before = await readSlotRow(slotId);
      // Rebinding now restores retained artifacts after the claim. If that fails,
      // the outer catch must roll back this tentative owner before run.slotId is written.
      bound = { slotId, before };
      const rebound = await (dependencies.rebindSlot ?? rebindUnownedPublicationSlot)(
        { ...current, slotId },
        { expectedHeadSha: request.headSha },
      );
      if (!rebound)
        throw new Error(
          `Slot ${slotId} is not free with the run branch at ${request.headSha} checked out`,
        );
      return updateRun(current.id, { slotId });
    };
    const assertCurrent = async (snapshot: Run) => {
      if (JSON.stringify(authorize()) !== actor)
        throw new GatewayMethodError('AUTH_FORBIDDEN', 'Review budget approver changed');
      const refusal = reviewBudgetExtensionRefusal(snapshot);
      if (refusal) throw new Error(`Review budget extension refused: ${refusal}.`);
      // The grant's own checks have passed; only then does a named slot get claimed.
      const current = naming && !bound ? await bindNamedSlot(snapshot) : snapshot;
      if (
        identity(current) !== expected ||
        !current.branch ||
        !current.slotId ||
        isGateParkInFlightOrFreed(current)
      )
        throw new Error('Review budget extension requires the same owned unpublished run');
      // Budget failure releases the lease while keeping the checkout. Recover it with the
      // gate's existing branch/owner guards before verifying the approved head.
      if (current.status === 'failed')
        await (dependencies.rebindSlot ?? rebindUnownedPublicationSlot)(current, {
          expectedHeadSha: request.headSha,
        });
      const source = await (dependencies.source ?? capturePublicationSource)(current);
      if (slotEpoch !== undefined && source.slotEpoch !== slotEpoch)
        throw new Error('Publication source slot epoch changed');
      slotEpoch = source.slotEpoch;
      if (
        source.headSha !== request.headSha ||
        identity(getRun(current.id)!) !== expected ||
        JSON.stringify(authorize()) !== actor
      )
        throw new Error('Run head, ownership or approver changed while extending review budget');
    };
    let result: Awaited<ReturnType<typeof extendReviewRoundBudget>>;
    try {
      result = await extendReviewRoundBudget(request, principal, assertCurrent);
    } catch (error) {
      if (bound) await unbindNamedSlot(run.id, bound.slotId, bound.before);
      throw error;
    }
    const updated = getRun(run.id)!;
    emit(Events.RUN_UPDATED, { run: updated });
    return { run: updated, ...result };
  });
  // A waiting publish gate is presented again with the granted limit and the actions it allows,
  // such as Continue Fixing (ADR-063 Amendments 1 and 4). Hold only re-presents; nothing starts.
  // As run.decide does, the stored card is resolved before the engine wakes, so one gate stays
  // pending. Only a publication gate: on a Mark Ready gate, Hold completes the step.
  const current = getRun(extended.run.id)!;
  const gate = requiresPublicationApproval(current)
    ? current.decisions.find(
        (decision) =>
          decision.type === 'engine_human_gate' &&
          !decision.resolvedAt &&
          decision.payload?.kind === 'ready' &&
          hasEngineDecisionWaiter(decision.id),
      )
    : undefined;
  if (gate) {
    recordDecisionResolution(current.id, gate.id, 'hold');
    resolveEngineDecision(gate.id, 'hold');
    return { ...extended, run: getRun(current.id)! };
  }
  // A held result decision offers Send back once the granted round exists.
  if (!isHeldForResultDecision(extended.run)) return extended;
  const { representResultDecision } = await import('../../run-completion/result-decision.js');
  const represented = await representResultDecision(extended.run.id);
  return represented ? { ...extended, run: represented } : extended;
}
