import { resourceQuery, type ResourceReadMethod } from '@farmslot/protocol/client-cache';

import { getResourceCache, getResourceWorkspaceKey } from './resource-cache';

/** One-shot configuration consumers share canonical reads; commands never use this helper. */
export async function readConfiguration<T>(
  method: ResourceReadMethod,
  params: unknown = {},
): Promise<T> {
  const cache = getResourceCache();
  const owner = getResourceWorkspaceKey();
  if (!cache) throw new Error('Configuration store is unavailable');
  const query = resourceQuery<T>(method, params);
  if (!query.dependencies.some((key) => key.family === 'configuration'))
    throw new Error('Expected a registered configuration read');
  let state = cache.read(query);
  if (state.status !== 'ready') state = await cache.retry(query);
  if (cache !== getResourceCache() || owner !== getResourceWorkspaceKey())
    throw new Error('Configuration owner changed during read');
  if (state.status !== 'ready' || state.data === undefined)
    throw new Error(state.error?.message ?? 'Wait for current configuration before acting');
  return state.data;
}
