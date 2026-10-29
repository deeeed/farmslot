import { useSyncExternalStore } from 'react';

import { useConnectionStore } from '../store/connection';

import { getResourceWorkspaceAccess, subscribeResourceCache } from './resource-cache';

/** Kept scope opens cached screens while offline; commands use currentFarmConnection. */
export function useWorkspaceRenderAccess() {
  const access = useConnectionStore((state) => state.workspaceAccess);
  const connected = useConnectionStore((state) => state.status === 'connected');
  const remembered = useSyncExternalStore(
    subscribeResourceCache,
    getResourceWorkspaceAccess,
    getResourceWorkspaceAccess,
  );
  return connected || remembered === 'none' ? access : remembered;
}
