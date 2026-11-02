import type { ResourceQuery } from './registry.js';
import type { GatewayResourceCache } from './types.js';

type StoredResourceReader = Pick<GatewayResourceCache, 'retry' | 'readStored'>;

/** Display reads may use held data after a failed refresh, within the same cache owner. */
export async function readStoredResource<T>(
  current: () => StoredResourceReader | undefined,
  query: ResourceQuery<T>,
): Promise<T> {
  const cache = current();
  if (!cache) throw new Error('The offline store is not open yet');
  const held = cache.readStored ? await cache.readStored(query) : undefined;
  const state = held?.data !== undefined ? held : await cache.retry(query);
  if (cache !== current()) throw new Error('The offline store owner changed');
  if (state.data === undefined) throw new Error(state.error?.message ?? 'Nothing stored yet');
  return state.data;
}
