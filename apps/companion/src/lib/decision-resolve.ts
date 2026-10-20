import {
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
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
  evidenceAttestationReason?: string,
  /** Written reason for a result decision or for accepting review findings; both require one. */
  reason?: string,
): DecisionResolveRequest {
  if (!decision.runMeta) {
    if (actionId === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION)
      throw new Error('Load the publish run before attesting evidence.');
    if (actionId === APPROVE_PUBLISH_UNRESOLVED_ACTION)
      throw new Error('Load the publish run before accepting review findings.');
    if (decision.payload?.kind === 'review' && actionId === 'post')
      throw new Error('Load the review run before posting selected findings.');
    return { method: Methods.DECISION_RESOLVE, params: { decisionId: decision.id, actionId } };
  }
  return buildRunDecisionActionRequest({
    runId: decision.runMeta.runId,
    decision,
    actionId,
    ...(evidenceAttestationReason !== undefined ? { evidenceAttestationReason } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(selectionData ? { selectionData } : {}),
    ...(resourcePosture ? { resourcePosture } : {}),
  });
}
