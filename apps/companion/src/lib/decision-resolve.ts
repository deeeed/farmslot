import {
  buildRunDecisionActionRequest,
  type DecisionResolveParams,
  Methods,
  type PendingDecision,
  type ResourcePostureGateChoice,
  type RunDecisionActionRequest,
} from '@farmslot/protocol';

export type DecisionResolveRequest =
  | RunDecisionActionRequest
  | { method: typeof Methods.DECISION_RESOLVE; params: DecisionResolveParams };

/**
 * The resolve call every Companion decision surface sends. A decision known with
 * its run goes through the shared run action request: bound to the package on
 * screen, with an improvement's Apply routed to `improvement.apply`. Any other
 * resolves through `decision.resolve`, which has nowhere to carry a posture
 * choice or a selection.
 */
export function decisionResolveRequest(
  decision: Pick<PendingDecision, 'id' | 'payload' | 'runMeta'> &
    Partial<Pick<PendingDecision, 'type'>>,
  actionId: string,
  resourcePosture?: ResourcePostureGateChoice | null,
  selectionData?: Record<string, unknown>,
): DecisionResolveRequest {
  if (!decision.runMeta) {
    return { method: Methods.DECISION_RESOLVE, params: { decisionId: decision.id, actionId } };
  }
  return buildRunDecisionActionRequest({
    runId: decision.runMeta.runId,
    decision,
    actionId,
    ...(selectionData ? { selectionData } : {}),
    ...(resourcePosture ? { resourcePosture } : {}),
  });
}
