import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import {
  createSourceCommandClient,
  type PreparedSourceCommand,
  type SourceSelection,
  SourceStatusController,
  type SourceStatusViewContext,
} from '@farmslot/protocol';

import { observeSourcesController } from '../../farmslot/sources-cache-proof';
import { currentFarmConnection } from '../../lib/connection-authority';
import {
  getResourceCache,
  getResourceWorkspaceKey,
  subscribeResourceCache,
} from '../../lib/resource-cache';
import { useConnectionStore } from '../../store/connection';

export function useSourceStatusController(
  context: SourceStatusViewContext,
  onSelectionsChange?: (selections: SourceSelection[]) => void,
  onSelectionStateChange?: (refusal: string | undefined) => void,
) {
  const client = useConnectionStore((state) => state.client);
  const profileId = useConnectionStore((state) => state.activeProfileId);
  const cache = useSyncExternalStore(subscribeResourceCache, getResourceCache, getResourceCache);
  const workspaceKey = useSyncExternalStore(
    subscribeResourceCache,
    getResourceWorkspaceKey,
    getResourceWorkspaceKey,
  );
  const callback = useRef(onSelectionsChange);
  callback.current = onSelectionsChange;
  const stateCallback = useRef(onSelectionStateChange);
  stateCallback.current = onSelectionStateChange;
  const controller = useMemo(
    () =>
      new SourceStatusController(
        createSourceCommandClient(
          async <T>(method: PreparedSourceCommand['method'], params: unknown): Promise<T> => {
            if (!client) throw new Error('Connect to the farm to inspect sources.');
            const current = currentFarmConnection(client, () => useConnectionStore.getState());
            const result = await client.request<T>(method, params, 120_000);
            if (!current()) throw new Error('Source connection changed before acknowledgement.');
            return result;
          },
          getResourceCache,
        ),
        { actions: [] },
      ),
    [client],
  );
  const connectedContext = {
    ...context,
    connectionKey:
      workspaceKey ??
      JSON.stringify([
        profileId,
        client?.gatewayUrl,
        client?.authenticatedPrincipal?.id,
        client?.authenticatedPrincipal?.generation,
      ]),
  };
  const key = JSON.stringify(connectedContext);
  const contextRef = useRef(connectedContext);
  contextRef.current = connectedContext;
  useEffect(() => {
    controller.bind(contextRef.current, getResourceCache());
  }, [controller, key, cache]);
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    if (__DEV__) return observeSourcesController(controller);
  }, [controller]);
  useEffect(() => {
    let previous = controller.getSnapshot().selections;
    return controller.subscribe(() => {
      stateCallback.current?.(controller.getSnapshot().selectionRefusal);
      const selections = controller.getSnapshot().selections;
      if (previous !== selections) {
        previous = selections;
        callback.current?.(selections);
      }
    });
  }, [controller]);
  const viewModel = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return {
    viewModel,
    controller,
    visible:
      client?.workspaceAccess === 'farm' ||
      (client?.connectionState !== 'connected' && viewModel.view !== undefined),
  };
}
