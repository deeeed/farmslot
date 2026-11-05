import {
  type GitShowParams,
  type GitShowResult,
  type ReviewedFindingContext,
  reviewedFindingContext,
  type ReviewGatePayload,
} from '@farmslot/protocol';
import {
  readGitSource,
  readStoredResource,
  resourceQuery,
  type ResourceReadMethod,
} from '@farmslot/protocol/client-cache';

import { getResourceCache } from './resource-cache';

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

/** Display reads keep held source available offline; they never authorize a write. */
export async function readReviewWorkspace<T>(
  method: ResourceReadMethod,
  params: unknown,
): Promise<T> {
  return readStoredResource(getResourceCache, resourceQuery<T>(method, params));
}

/** A slotless review run has no live workspace; it reads its frozen head through the run. */
async function readReviewSource(params: GitShowParams): Promise<GitShowResult> {
  if ((!params.slotId && !params.runId) || !params.ref || !params.path)
    throw new Error('Reviewed source is unavailable');
  return readGitSource(getResourceCache, params);
}

export async function loadReviewFindingSource(
  params: GitShowParams,
  line: number,
  isCurrent: () => boolean,
): Promise<ReviewedFindingContext | null> {
  const result = await readReviewSource(params);
  return isCurrent() ? reviewedFindingContext(result.content, line) : null;
}
