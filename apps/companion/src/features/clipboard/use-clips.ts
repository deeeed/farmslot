import { useMemo } from 'react';

import { type ClipListResult, Methods } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { useWorkspaceRenderAccess } from '../../lib/use-workspace-render-access';

/** The farm's clips, newest first; gateway notices keep it current. */
export function useClips() {
  const access = useWorkspaceRenderAccess();
  const query = useMemo(
    () => (access === 'farm' ? resourceQuery<ClipListResult>(Methods.CLIP_LIST, {}) : undefined),
    [access],
  );
  return useResourceQuery(query);
}
