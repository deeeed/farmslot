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
import {
  extendReviewRoundBudget,
  reviewBudgetExtensionRefusal,
} from '../../review/review-round-budget.js';
import { publicationStatusForRun } from '../../run-completion/orchestrator.js';
import { capturePublicationSource } from '../../run-completion/publication-source.js';
import { resolveEngineDecision } from '../../run-engine/engine-decisions.js';
import { withRunTransition } from '../../run-lifecycle/transition-coordinator.js';
import { getRun } from '../../runs/store.js';

export interface ReviewBudgetExtensionDependencies {
  authorize?: () => Principal;
  source?: typeof capturePublicationSource;
  resolveEngineDecision?: typeof resolveEngineDecision;
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
  const request = {
    ...params,
    headSha: params.headSha.toLowerCase(),
    scopeBrief: params.scopeBrief.trim(),
  };
  const extended = await withRunTransition(params.runId, async () => {
    const run = getRun(params.runId);
    if (!run) throw new Error(`Run not found: ${params.runId}`);
    const expected = identity(run);
    const actor = JSON.stringify(principal);
    let slotEpoch: number | undefined;
    const assertCurrent = async (current: Run) => {
      if (JSON.stringify(authorize()) !== actor)
        throw new GatewayMethodError('AUTH_FORBIDDEN', 'Review budget approver changed');
      const refusal = reviewBudgetExtensionRefusal(current);
      if (refusal) throw new Error(`Review budget extension refused: ${refusal}.`);
      if (
        identity(current) !== expected ||
        !current.branch ||
        !current.slotId ||
        isGateParkInFlightOrFreed(current)
      )
        throw new Error('Review budget extension requires the same owned unpublished run');
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
    const result = await extendReviewRoundBudget(request, principal, assertCurrent);
    const updated = getRun(run.id)!;
    emit(Events.RUN_UPDATED, { run: updated });
    return { run: updated, ...result };
  });
  // A waiting publish gate is presented again with the granted limit and the actions it allows,
  // such as Continue Fixing (ADR-063 Amendments 1 and 4). Hold only re-presents; nothing starts.
  const gate = extended.run.decisions.find(
    (decision) =>
      decision.type === 'engine_human_gate' &&
      !decision.resolvedAt &&
      decision.payload?.kind === 'ready' &&
      decision.actions.some((action) => action.id === 'hold'),
  );
  if (gate && (dependencies.resolveEngineDecision ?? resolveEngineDecision)(gate.id, 'hold'))
    return extended;
  // A held result decision offers Send back once the granted round exists.
  if (!isHeldForResultDecision(extended.run)) return extended;
  const { representResultDecision } = await import('../../run-completion/result-decision.js');
  const represented = await representResultDecision(extended.run.id);
  return represented ? { ...extended, run: represented } : extended;
}
