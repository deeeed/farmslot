import { readStoredArtifactResponse } from '@farmslot/protocol/client-cache';

import { useConnectionStore } from '../store/connection';

import { gatewayFetch, type GatewayHttpAuthHeaders } from './gateway-http-auth';
import { getResourceCache, reportArtifactRefreshError } from './resource-cache';

export interface StoredArtifactRequestInit extends RequestInit {
  onStored?(response: Response): unknown;
}

export function readStoredArtifact(
  url: string,
  headers: GatewayHttpAuthHeaders,
  init?: StoredArtifactRequestInit,
): Promise<Response> {
  return readStoredArtifactResponse({
    current: getResourceCache,
    url,
    online: useConnectionStore.getState().status === 'connected',
    read: () => gatewayFetch(url, headers, init),
    signal: init?.signal ?? undefined,
    refresh: init?.cache === 'reload',
    onStored: init?.onStored,
    onRefreshError: reportArtifactRefreshError,
  });
}

/** Closing a document retires both its held display and any pending fresh reply. */
export function closeArtifactDocument(
  pending: { current: AbortController | null },
  dismiss: () => void,
): void {
  pending.current?.abort();
  pending.current = null;
  dismiss();
}
