import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import {
  buildRunDecisionActionRequest,
  MARK_CLAIM_UNTESTABLE_ACTION,
  type RunDecision,
  type RunOverrideClaimResult,
} from '@farmslot/protocol';

import type { GatewayClient } from './gateway-client';

/** Both native gate contexts use the public request builder and keep their decision open. */
export function requestClaimUntestableOverride(
  client: GatewayClient,
  runId: string,
  decision: RunDecision,
  model: EvidenceReviewModel,
  claimId: string,
  reason: string,
): Promise<RunOverrideClaimResult> {
  const candidate = model.claimOverrideCandidate(claimId);
  if (!candidate) throw new Error('This claim has no checked selected execution to override.');
  const request = buildRunDecisionActionRequest({
    runId,
    decision,
    actionId: MARK_CLAIM_UNTESTABLE_ACTION,
    ...candidate,
    claimOverrideReason: reason,
  });
  return client.request<RunOverrideClaimResult>(request.method, request.params);
}
