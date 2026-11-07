import type { ChatHistoryResult, NativeSessionTargetParams } from '@farmslot/protocol';
import {
  type GatewayResourceCache,
  type NativeConversationState,
  observeLegacyConversation,
  observeNativeConversation,
  type ResourceQuery,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

import {
  getResourceCache,
  getResourceWorkspaceKey,
  subscribeResourceCache,
} from '../../resource-cache.js';

/** Subscribe through the existing owner; a retired owner's late callbacks cannot repaint. */
function observeOwnedNative<T>(
  observe: (
    cache: GatewayResourceCache,
    changed: (state: ResourceQueryState<T>) => void,
  ) => () => void,
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
    stop = observe(next, (state) => {
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

export function observeNativeResource<T>(
  query: ResourceQuery<T>,
  changed: (state: ResourceQueryState<T>) => void,
): () => void {
  return observeOwnedNative((cache, listener) => cache.observe(query, listener), changed);
}
export function observeNativeConversationResource(
  target: NativeSessionTargetParams,
  changed: (state: NativeConversationState) => void,
): () => void {
  return observeOwnedNative(
    (cache, listener) => observeNativeConversation(cache, target, listener),
    changed,
  );
}

export function observeNativeArchiveResource(
  sessionId: string,
  changed: (state: ResourceQueryState<ChatHistoryResult>) => void,
): () => void {
  return observeOwnedNative(
    (cache, listener) => observeLegacyConversation(cache, sessionId, listener),
    changed,
  );
}
