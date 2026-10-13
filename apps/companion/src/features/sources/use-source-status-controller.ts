import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import {
  createSourceCommandClient,
  type SourceSelection,
  SourceStatusController,
  type SourceStatusViewContext,
} from '@farmslot/protocol';

import { useConnectedTransport } from '../../hooks/useConnectedTransport';
import { currentFarmConnection } from '../../lib/connection-authority';
import { useConnectionStore } from '../../store/connection';

export function useSourceStatusController(
  context: SourceStatusViewContext,
  onSelectionsChange?: (selections: SourceSelection[]) => void,
  onSelectionStateChange?: (refusal: string | undefined) => void,
) {
  const client = useConnectionStore((state) => state.client);
  const profileId = useConnectionStore((state) => state.activeProfileId);
  const generation = useConnectedTransport();
  const callback = useRef(onSelectionsChange);
  callback.current = onSelectionsChange;
  const stateCallback = useRef(onSelectionStateChange);
  stateCallback.current = onSelectionStateChange;
  const controller = useMemo(
    () =>
      new SourceStatusController(
        createSourceCommandClient(async <T>(method: string, params: unknown): Promise<T> => {
          if (!client) throw new Error('Connect to the farm to inspect sources.');
          const current = currentFarmConnection(client, () => useConnectionStore.getState());
          const result = await client.request<T>(method, params, 120_000);
          if (!current()) throw new Error('Source connection changed before acknowledgement.');
          return result;
        }),
        { actions: [] },
      ),
    [client],
  );
  const connectedContext = {
    ...context,
    connectionKey: `${profileId}|${client?.authenticatedPrincipal?.id ?? ''}`,
  };
  const key = JSON.stringify(connectedContext);
  const contextRef = useRef(connectedContext);
  const lastTransport = useRef<{
    controller: SourceStatusController;
    generation: number | null;
  } | null>(null);
  contextRef.current = connectedContext;
  useEffect(() => {
    const changed = controller.setContext(contextRef.current);
    const transportChanged =
      lastTransport.current?.controller !== controller ||
      lastTransport.current.generation !== generation;
    lastTransport.current = { controller, generation };
    if ((changed || transportChanged) && generation !== null && client?.workspaceAccess === 'farm')
      void controller.refresh();
  }, [controller, key, generation, client]);
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
  return { viewModel, controller, visible: client?.workspaceAccess === 'farm' };
}
