import { useMemo, useSyncExternalStore } from 'react';

import { type ClipListResult, Methods } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { getResourceNativeOwnerId, subscribeResourceCache } from '../../lib/resource-cache';
import { useWorkspaceRenderAccess } from '../../lib/use-workspace-render-access';

/** The signed-in principal's clips, newest first; gateway notices keep it current. */
export function useClips() {
  const access = useWorkspaceRenderAccess();
  const owner = useSyncExternalStore(
    subscribeResourceCache,
    getResourceNativeOwnerId,
    getResourceNativeOwnerId,
  );
  const query = useMemo(
    () =>
      access === 'farm' && owner
        ? resourceQuery<ClipListResult>(Methods.CLIP_LIST, {}, owner)
        : undefined,
    [access, owner],
  );
  return useResourceQuery(query);
}
