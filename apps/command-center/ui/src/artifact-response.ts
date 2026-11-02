import { readStoredArtifactResponse } from '@farmslot/protocol/client-cache';

import { gatewayHttpFetch, gatewayHttpOrigin } from './utils/gateway-origin.js';
import { gateway } from './gateway-client.js';
import { getResourceCache } from './resource-cache.js';

export function readStoredArtifact(url: string, init?: RequestInit): Promise<Response> {
  return readStoredArtifactResponse({
    current: getResourceCache,
    url: new URL(url, gatewayHttpOrigin()).href,
    online: gateway.connectionState === 'connected',
    read: () => gatewayHttpFetch(url, init),
    signal: init?.signal ?? undefined,
  });
}
