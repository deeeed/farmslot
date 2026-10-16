import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import { Methods, type RunReviewVisualClaimResult } from '@farmslot/protocol';

import type { GatewayClient } from './gateway-client';

/** Submit only the exact evidence model the person is looking at. */
export async function recordVisualClaimReview(
  client: GatewayClient | null,
  runId: string | undefined,
  model: EvidenceReviewModel | null,
  claimId: string,
  verdict: 'confirmed' | 'rejected',
  reason?: string,
): Promise<RunReviewVisualClaimResult> {
  if (!client || !model) throw new Error('The evidence review is unavailable.');
  const params = model.visualReviewRequest(claimId, client.authenticatedPrincipal, verdict, reason);
  if (params.runId !== runId) throw new Error('The run changed. Refresh the evidence.');
  return client.request<RunReviewVisualClaimResult>(Methods.RUN_REVIEW_VISUAL_CLAIM, params);
}
