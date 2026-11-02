import { readStoredArtifactResponse } from '@farmslot/protocol/client-cache';

import { useConnectionStore } from '../store/connection';

import { gatewayFetch, type GatewayHttpAuthHeaders } from './gateway-http-auth';
import { getResourceCache, reportArtifactRefreshError } from './resource-cache';

export function readStoredArtifact(
  url: string,
  headers: GatewayHttpAuthHeaders,
  init?: RequestInit,
): Promise<Response> {
  return readStoredArtifactResponse({
    current: getResourceCache,
    url,
    online: useConnectionStore.getState().status === 'connected',
    read: () => gatewayFetch(url, headers, init),
    signal: init?.signal ?? undefined,
    refresh: init?.cache === 'reload',
    onRefreshError: reportArtifactRefreshError,
  });
}
