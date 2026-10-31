import { useCallback } from 'react';

import { type CopilotStatusResult, Methods } from '@farmslot/protocol';
import { canActOn, heldDataIsSaved, resourceQuery } from '@farmslot/protocol/client-cache';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { getResourceCache } from '../../lib/resource-cache';
import { visibleReadError } from '../../lib/resource-read-status';
import { useWorkspaceRenderAccess } from '../../lib/use-workspace-render-access';
import { useConnectionStore } from '../../store/connection';
import { useHeldConnection } from '../../store/held-connection';

const runtimeQuery = resourceQuery<CopilotStatusResult>(Methods.COPILOT_STATUS, {});

export function useCopilotController() {
  // Connected, or within a short reconnect: the saved status renders and acts silently.
  const connected = useHeldConnection();
  const renderAccess = useWorkspaceRenderAccess();
  const state = useResourceQuery(renderAccess === 'farm' ? runtimeQuery : undefined);
  const refresh = useCallback(async () => {
    if (!state.error || useConnectionStore.getState().status !== 'connected') return;
    if (useConnectionStore.getState().workspaceAccess !== 'farm') return;
    await getResourceCache()?.retry(runtimeQuery);
  }, [state.error]);
  const saved = heldDataIsSaved(state, connected);
  return {
    viewModel: {
      runtime: state.data?.session ?? null,
      loading: state.status === 'loading',
      // A read outcome on this connection, never a saved row still awaiting its read.
      settled: state.status === 'ready' || state.status === 'unsupported' || Boolean(state.error),
      error: visibleReadError(state, saved)?.message ?? '',
      connected,
      ready: canActOn(state, connected),
      saved,
      observedAt: state.observedAt,
    },
    actions: { refresh },
  };
}
