import {
  Methods,
  type ReviewRoundBudget,
  type RunExtendReviewBudgetResult,
} from '@farmslot/protocol';
import { anotherReviewRoundParams } from '@farmslot/review-dispatch';

import type { GatewayClient } from './gateway-client';

/** The gate fields the request reads; a `RunDecision` is one. */
export interface ExtendableGate {
  id: string;
  payload?: {
    kind: string;
    reviewRoundBudget?: Pick<ReviewRoundBudget, 'limit'>;
    prPackage?: { headSha?: string } | null;
  } | null;
}

/** One more review round on this gate (admin), as desktop requests it. */
export function requestAnotherReviewRound(
  client: Pick<GatewayClient, 'request'>,
  runId: string,
  gate: ExtendableGate,
  brief: string,
): Promise<RunExtendReviewBudgetResult> {
  const payload = gate.payload?.kind === 'ready' ? gate.payload : undefined;
  const budget = payload?.reviewRoundBudget;
  const headSha = payload?.prPackage?.headSha;
  if (!budget || !headSha)
    throw new Error('This gate has no review budget or package head to extend.');
  return client.request<RunExtendReviewBudgetResult>(
    Methods.RUN_EXTEND_REVIEW_BUDGET,
    anotherReviewRoundParams({ runId, decisionId: gate.id, budget, headSha, brief }),
  );
}
