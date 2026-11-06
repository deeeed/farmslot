import { useCallback, useSyncExternalStore } from 'react';

import type { NativeSessionTargetParams } from '@farmslot/protocol';
import {
  type NativeConversationState,
  observeNativeConversation,
} from '@farmslot/protocol/client-cache';

import {
  getResourceCache,
  getResourceWorkspaceKey,
  subscribeResourceCache,
} from '../lib/resource-cache';

const loading: NativeConversationState = { status: 'loading' };

/** Thin platform binding. The scoped cache owns replay, reduction, persistence and reconnect. */
export function useNativeConversation(
  target: NativeSessionTargetParams | undefined,
  focused: boolean,
): NativeConversationState {
  const cache = useSyncExternalStore(subscribeResourceCache, getResourceCache, getResourceCache);
  const key = useSyncExternalStore(
    subscribeResourceCache,
    getResourceWorkspaceKey,
    getResourceWorkspaceKey,
  );
  const subscribe = useCallback(
    (changed: () => void) =>
      cache && target && focused
        ? observeNativeConversation(cache, target, changed)
        : () => undefined,
    [cache, key, target, focused],
  );
  const snapshot = useCallback(
    () =>
      cache && target && cache === getResourceCache() && key === getResourceWorkspaceKey()
        ? (cache.conversations?.read(target) ?? loading)
        : loading,
    [cache, key, target],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
