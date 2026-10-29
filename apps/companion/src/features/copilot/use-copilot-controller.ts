import { useCallback } from 'react';

import { type CopilotStatusResult, Methods } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { getResourceCache } from '../../lib/resource-cache';
import { useWorkspaceRenderAccess } from '../../lib/use-workspace-render-access';
import { useConnectionStore } from '../../store/connection';

const runtimeQuery = resourceQuery<CopilotStatusResult>(Methods.COPILOT_STATUS, {});

export function useCopilotController() {
  const connectionStatus = useConnectionStore((state) => state.status);
  const renderAccess = useWorkspaceRenderAccess();
  const state = useResourceQuery(renderAccess === 'farm' ? runtimeQuery : undefined);
  const refresh = useCallback(async () => {
    if (!state.error || useConnectionStore.getState().status !== 'connected') return;
    if (useConnectionStore.getState().workspaceAccess !== 'farm') return;
    await getResourceCache()?.retry(runtimeQuery);
  }, [state.error]);
  return {
    viewModel: {
      runtime: state.data?.session ?? null,
      loading: state.status === 'loading',
      // A read outcome on this connection, never a saved row still awaiting its read.
      settled: state.status === 'ready' || state.status === 'unsupported' || Boolean(state.error),
      error: state.error?.message ?? '',
      connected: connectionStatus === 'connected',
      ready: connectionStatus === 'connected' && state.status === 'ready',
      status: state.status,
      observedAt: state.observedAt,
    },
    actions: { refresh },
  };
}
