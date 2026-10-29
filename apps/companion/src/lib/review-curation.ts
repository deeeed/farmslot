import {
  type GitShowParams,
  type GitShowResult,
  Methods,
  type ReviewedFindingContext,
  reviewedFindingContext,
  type ReviewGatePayload,
} from '@farmslot/protocol';
import { resourceQuery, type ResourceReadMethod } from '@farmslot/protocol/client-cache';

import type { GatewayClient } from './gateway-client';
import { getResourceCache, getResourceWorkspaceKey } from './resource-cache';

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

/** Live slot review reads share the current owner's workspace cache; a ready entry is current. */
export async function readReviewWorkspace<T>(
  method: ResourceReadMethod,
  params: unknown,
): Promise<T> {
  const cache = getResourceCache();
  const owner = getResourceWorkspaceKey();
  if (!cache) throw new Error('Workspace store is unavailable');
  const query = resourceQuery<T>(method, params);
  let state = cache.read(query);
  if (state.status !== 'ready') state = await cache.retry(query);
  if (cache !== getResourceCache() || owner !== getResourceWorkspaceKey())
    throw new Error('Farm connection changed');
  if (state.status !== 'ready' || state.data === undefined)
    throw new Error(state.error?.message ?? 'Wait for a current workspace source');
  return state.data;
}

/** A slotless review run has no live workspace; it reads its frozen head through the run. */
async function readReviewSource(
  client: Pick<GatewayClient, 'request'>,
  params: GitShowParams,
): Promise<GitShowResult> {
  if (params.slotId) return readReviewWorkspace<GitShowResult>(Methods.GIT_SHOW, params);
  const { runId = '', ref, path } = params;
  if (!runId || !ref || !path) throw new Error('Reviewed source is unavailable');
  return client.request<GitShowResult>(Methods.GIT_SHOW, { slotId: '', runId, ref, path });
}

export async function loadReviewFindingSource(
  client: Pick<GatewayClient, 'request'>,
  params: GitShowParams,
  line: number,
  isCurrent: () => boolean,
): Promise<ReviewedFindingContext | null> {
  const result = await readReviewSource(client, params);
  return isCurrent() ? reviewedFindingContext(result.content, line) : null;
}
