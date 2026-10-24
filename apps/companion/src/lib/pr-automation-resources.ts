import { Methods } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { getResourceCache, getResourceWorkspaceKey } from './resource-cache';

/** One-shot registration admission shares the current owner's read, never its commands. */
export async function readPRPushDevices<T>(): Promise<T> {
  const cache = getResourceCache();
  const owner = getResourceWorkspaceKey();
  if (!cache) throw new Error('PR automation store is unavailable');
  const query = resourceQuery<T>(Methods.PR_PUSH_LIST);
  let state = cache.read(query);
  if (state.status !== 'ready') state = await cache.retry(query);
  if (cache !== getResourceCache() || owner !== getResourceWorkspaceKey())
    throw new Error('PR automation owner changed during read');
  state = cache.read(query);
  if (state.status !== 'ready' || state.data === undefined)
    throw new Error(state.error?.message ?? 'Wait for current notification settings before acting');
  return state.data;
}
