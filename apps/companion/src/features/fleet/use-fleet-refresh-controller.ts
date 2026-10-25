import { useEffect, useMemo, useState } from 'react';

import { FleetRefreshViewModel } from '@farmslot/review-dispatch';

import { currentFarmConnection } from '../../lib/connection-authority';
import { useConnectionStore } from '../../store/connection';

export function useFleetRefreshController() {
  const client = useConnectionStore((state) => state.client);
  const profileId = useConnectionStore((state) => state.activeProfileId);
  const principalId = useConnectionStore((state) => state.client?.authenticatedPrincipal?.id ?? '');
  const [, render] = useState(0);
  const model = useMemo(
    () =>
      client
        ? new FleetRefreshViewModel(
            {
              contextKey: () =>
                JSON.stringify([
                  useConnectionStore.getState().activeProfileId,
                  useConnectionStore.getState().gatewayUrl,
                  client.connectionGeneration,
                  client.authenticatedPrincipal?.id ?? '',
                ]),
              request: async <T>(
                method: string,
                params?: unknown,
                timeout?: number,
              ): Promise<T> => {
                const current = currentFarmConnection(client, () => useConnectionStore.getState());
                if (!current()) throw new Error('Connect to the farm before releasing slots');
                const result = await client.request<T>(method, params, timeout);
                if (!current()) throw new Error('Farm connection changed before acknowledgement');
                return result;
              },
              subscribe: (event, callback) => client.subscribe(event, callback),
            },
            () => `fleet-refresh-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          )
        : null,
    [client, profileId, principalId],
  );
  useEffect(() => {
    const unsubscribe = model?.subscribe(() => render((value) => value + 1));
    return () => {
      unsubscribe?.();
      model?.dispose();
    };
  }, [model]);
  return model;
}
