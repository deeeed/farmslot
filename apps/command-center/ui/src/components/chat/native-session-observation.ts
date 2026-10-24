import type { ResourceQuery, ResourceQueryState } from '@farmslot/protocol/client-cache';

import {
  getResourceCache,
  getResourceWorkspaceKey,
  subscribeResourceCache,
} from '../../resource-cache.js';

/** Subscribe through the existing owner; a retired owner's late callbacks cannot repaint. */
export function observeNativeResource<T>(
  query: ResourceQuery<T>,
  changed: (state: ResourceQueryState<T>) => void,
): () => void {
  let stop: (() => void) | undefined;
  let active = true;
  let identity: string | undefined;
  let cache: ReturnType<typeof getResourceCache>;
  const bind = () => {
    const next = getResourceCache();
    const key = getResourceWorkspaceKey();
    if (next === cache && key === identity) return;
    stop?.();
    cache = next;
    identity = key;
    changed({ status: 'loading' });
    if (!next) return;
    stop = next.observe(query, (state) => {
      if (active && next === getResourceCache() && key === getResourceWorkspaceKey())
        changed(state);
    });
  };
  const ownerStop = subscribeResourceCache(bind);
  bind();
  return () => {
    active = false;
    stop?.();
    ownerStop();
  };
}
