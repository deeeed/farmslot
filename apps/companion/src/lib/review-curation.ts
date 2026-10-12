import {
  type GitShowParams,
  type GitShowResult,
  Methods,
  type ReviewedFindingContext,
  reviewedFindingContext,
  type ReviewGatePayload,
} from '@farmslot/protocol';

import type { GatewayClient } from './gateway-client';

export function reviewFindingSourceRequest(
  runId: string,
  slotId: string | null | undefined,
  payload: ReviewGatePayload,
  index: number,
): GitShowParams | null {
  const finding = payload.lineComments[index];
  const ref = payload.reviewSnapshot?.headSha?.trim();
  if (!runId || !ref || !finding?.path || !Number.isSafeInteger(finding.line) || finding.line < 1)
    return null;
  return { slotId: slotId ?? '', ...(slotId ? {} : { runId }), ref, path: finding.path };
}

export async function loadReviewFindingSource(
  client: Pick<GatewayClient, 'request'>,
  params: GitShowParams,
  line: number,
  isCurrent: () => boolean,
): Promise<ReviewedFindingContext | null> {
  const result = await client.request<GitShowResult>(Methods.GIT_SHOW, params);
  return isCurrent() ? reviewedFindingContext(result.content, line) : null;
}
