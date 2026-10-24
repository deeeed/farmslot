import { resourceQuery } from '@farmslot/protocol/client-cache';

import { gateway } from '../../gateway-client.js';
import { getResourceCache, getResourceWorkspaceKey } from '../../resource-cache.js';

type AssessmentRead = 'assessment.list' | 'assessment.get' | 'assessment.summary' | 'run.get';

/** Canonical memory-only observations. Report/test/evaluate/feedback remain live commands. */
export async function readAssessment<T>(
  method: AssessmentRead,
  params: unknown = {},
  refresh = false,
): Promise<T> {
  const cache = getResourceCache();
  const owner = getResourceWorkspaceKey();
  const connection = gateway.connectionEpoch;
  if (!cache) throw new Error('Assessment store is unavailable');
  const query = resourceQuery<T>(method, params);
  let state = cache.read(query);
  if (refresh || state.status !== 'ready') state = await cache.retry(query);
  if (
    cache !== getResourceCache() ||
    owner !== getResourceWorkspaceKey() ||
    connection !== gateway.connectionEpoch
  )
    throw new Error('Assessment owner or connection changed during read');
  state = cache.read(query);
  if (state.status !== 'ready' || state.data === undefined)
    throw new Error(state.error?.message ?? 'Wait for a current assessment read');
  return state.data;
}
