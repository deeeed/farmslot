import type { SourcesStatusResult } from '@farmslot/protocol';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  createResourceCacheTransport,
  type GatewayResourceCache,
  resourceQuery,
  type ResourceQueryState,
  type ResourceStore,
} from '@farmslot/protocol/client-cache';

import { gateway } from '../gateway-client.js';

let cache: GatewayResourceCache | undefined;
let latest: ResourceQueryState<SourcesStatusResult> | undefined;
let reads = 0;
let store: ResourceStore | undefined;

interface DevelopmentImportMeta extends ImportMeta {
  env: { DEV: boolean };
}

/** CDP proof uses the production adapter and controller without writing panel state. */
export async function offlineClientCacheProof(action: 'start' | 'snapshot' | 'reconnect' | 'stop') {
  if (!(import.meta as DevelopmentImportMeta).env.DEV)
    throw new Error('The resource cache proof is development-only');
  if (action === 'stop') {
    await cache?.dispose();
    cache = undefined;
  } else if (action === 'start' && !cache) {
    reads = 0;
    const transport = createResourceCacheTransport(
      {
        get resourceConnectionReason() {
          return gateway.resourceConnectionReason;
        },
        requestResource: (method, params, signal) => {
          reads++;
          return gateway.requestResource(method, params, signal);
        },
        subscribe: (event, listener) => gateway.subscribe(event, listener),
        onConnectionChange: (listener) => gateway.onConnectionChange(listener),
        reconnect: () => gateway.reconnect(),
      },
      () => ({
        id: gateway.connectionEpoch,
        connected: gateway.connectionState === 'connected',
        gatewayUrl: gateway.gatewayUrl,
        authentication: gateway.authenticatedConnection,
      }),
    );
    store = createMemoryResourceStore();
    cache = createGatewayResourceCache({ transport, store });
    cache.observe(resourceQuery<SourcesStatusResult>('sources.status'), (next) => {
      latest = next;
    });
  } else if (action === 'reconnect') gateway.reconnect();
  return {
    status: latest?.status,
    reads,
    pinRevision: latest?.data?.pinRevision,
    selections: latest?.data?.effectiveSelections,
    epoch: latest?.resourceState?.epoch,
    generation: gateway.authenticatedConnection?.principal?.generation,
    error: latest?.error,
    storeDeleted: store?.deleted,
  };
}
