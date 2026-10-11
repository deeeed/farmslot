import {
  buildRunResolveDecisionParams,
  type DecisionResolveParams,
  Methods,
  type PendingDecision,
  type ResourcePostureGateChoice,
  type RunResolveDecisionParams,
} from '@farmslot/protocol';

export type DecisionResolveRequest =
  | { method: typeof Methods.RUN_RESOLVE_DECISION; params: RunResolveDecisionParams }
  | { method: typeof Methods.DECISION_RESOLVE; params: DecisionResolveParams };

/**
 * The resolve call every Companion gate surface sends. A decision known with its
 * run resolves through `run.resolveDecision`, bound to the package on screen; any
 * other through `decision.resolve`, which has nowhere to carry a posture choice.
 */
export function decisionResolveRequest(
  decision: Pick<PendingDecision, 'id' | 'payload' | 'runMeta'>,
  actionId: string,
  resourcePosture?: ResourcePostureGateChoice | null,
): DecisionResolveRequest {
  if (!decision.runMeta) {
    return { method: Methods.DECISION_RESOLVE, params: { decisionId: decision.id, actionId } };
  }
  return {
    method: Methods.RUN_RESOLVE_DECISION,
    params: buildRunResolveDecisionParams({
      runId: decision.runMeta.runId,
      decision,
      actionId,
      ...(resourcePosture ? { resourcePosture } : {}),
    }),
  };
}
