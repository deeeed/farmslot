import type { SourcesStatusResult } from '@farmslot/protocol';
import {
  createGatewayResourceCache,
  createResourceCacheTransport,
  type GatewayResourceCache,
  resourceQuery,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

import { useConnectionStore } from '../store/connection';

import type { FarmslotRecipeUiObserver } from './RecipeBridgeProvider';

let cache: GatewayResourceCache | undefined;
let latest: ResourceQueryState<SourcesStatusResult> | undefined;
let reads = 0;
let connectionId = 0;

/** Recipe-only observation of the shared controller over the app's real authenticated socket. */
export const observeOfflineClientCacheProof: FarmslotRecipeUiObserver = async (refs) => {
  if (!__DEV__ || refs.length !== 1 || !refs[0].startsWith('offline-store-foundation:'))
    return undefined;
  const state = useConnectionStore.getState();
  const client = state.client;
  if (!client) throw new Error('Connect Companion before proving its resource cache');
  if (refs[0] === 'offline-store-foundation:stop') {
    await cache?.dispose();
    cache = undefined;
  } else if (refs[0] === 'offline-store-foundation:start' && !cache) {
    reads = 0;
    const transport = createResourceCacheTransport(
      {
        requestResource: (method, params, signal) => {
          reads++;
          return client.requestResource(method, params, signal);
        },
        subscribe: (event, listener) => client.subscribe(event, listener),
        onConnectionChange: (listener) =>
          client.onConnectionChange((status) => {
            if (status === 'connected') connectionId++;
            listener();
          }),
        reconnect: () => client.reconnect(),
      },
      () => ({
        id: connectionId,
        connected: client.connectionState === 'connected',
        gatewayUrl: useConnectionStore.getState().gatewayUrl,
        profileId: useConnectionStore.getState().activeProfileId,
        authentication: client.authenticatedConnection,
      }),
    );
    cache = createGatewayResourceCache({ transport });
    cache.observe(resourceQuery<SourcesStatusResult>('sources.status'), (next) => {
      latest = next;
    });
  } else if (refs[0] === 'offline-store-foundation:reconnect') client.reconnect();
  return {
    observations: {
      offlineStoreFoundation: {
        status: latest?.status,
        reads,
        pinRevision: latest?.data?.pinRevision,
        selections: latest?.data?.effectiveSelections,
        epoch: latest?.resourceState?.epoch,
        generation: client.authenticatedConnection?.principal?.generation,
        error: latest?.error,
      },
    },
  };
};
