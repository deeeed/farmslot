import { useEffect, useMemo, useState } from 'react';

import { Methods } from '@farmslot/protocol';
import { FleetRefreshViewModel } from '@farmslot/review-dispatch';

import { currentFarmConnection } from '../../lib/connection-authority';
import type { GatewayClient } from '../../lib/gateway-client';
import { nativeFleetQuery } from '../../lib/gateway-run-sync';
import { getResourceCache, getResourceWorkspaceKey } from '../../lib/resource-cache';
import { assertNativeFleetReady } from '../../lib/run-collections';
import { useConnectionStore } from '../../store/connection';

/** Inspection rereads the shared fleet observation; release and cancel stay explicit commands. */
export function fleetRefreshRequest(client: GatewayClient) {
  return async <T>(method: string, params?: unknown, timeout?: number): Promise<T> => {
    const current = currentFarmConnection(client, () => useConnectionStore.getState());
    if (!current()) throw new Error('Connect to the farm before releasing slots');
    if (method === Methods.FLEET_STATUS) {
      const cache = getResourceCache();
      const owner = getResourceWorkspaceKey();
      if (!cache) throw new Error('Offline fleet store is unavailable');
      const state = await cache.retry(nativeFleetQuery);
      if (!current() || cache !== getResourceCache() || owner !== getResourceWorkspaceKey())
        throw new Error('Farm connection changed; inspect again');
      if (state.status !== 'ready' || !state.data)
        throw new Error(state.error?.message ?? 'Wait for a current fleet read before acting.');
      return state.data as T;
    }
    let result: T;
    if (method === Methods.FLEET_REFRESH_SLOTS_CANCEL)
      result = await client.request<T>(Methods.FLEET_REFRESH_SLOTS_CANCEL, params, timeout);
    else if (method === Methods.SLOT_REFRESH) {
      assertNativeFleetReady();
      result = await client.request<T>(Methods.SLOT_REFRESH, params, timeout);
    } else if (method === Methods.FLEET_REFRESH_SLOTS) {
      assertNativeFleetReady();
      result = await client.request<T>(Methods.FLEET_REFRESH_SLOTS, params, timeout);
    } else throw new Error(`Fleet release does not send ${method}`);
    if (!current()) throw new Error('Farm connection changed before acknowledgement');
    return result;
  };
}

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
              request: fleetRefreshRequest(client),
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
