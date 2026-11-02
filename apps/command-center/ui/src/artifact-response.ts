import { readStoredArtifactResponse } from '@farmslot/protocol/client-cache';

import { gatewayHttpFetch, gatewayHttpOrigin } from './utils/gateway-origin.js';
import { notificationTray } from './utils/notification-tray.js';
import { gateway } from './gateway-client.js';
import { getResourceCache, getResourceWorkspaceKey } from './resource-cache.js';

export interface StoredArtifactRequestInit extends RequestInit {
  onStored?(response: Response): unknown;
}

export function readStoredArtifact(
  url: string,
  init?: StoredArtifactRequestInit,
): Promise<Response> {
  const owner = getResourceWorkspaceKey();
  const source = `artifact:${url}`;
  return readStoredArtifactResponse({
    current: getResourceCache,
    url: new URL(url, gatewayHttpOrigin()).href,
    online: gateway.connectionState === 'connected',
    read: () => gatewayHttpFetch(url, init),
    signal: init?.signal ?? undefined,
    refresh: init?.cache === 'reload',
    onStored: init?.onStored,
    onRefreshError: (error) =>
      notificationTray.set(
        source,
        owner,
        error
          ? [
              {
                id: 'artifact-refresh',
                title: 'Saved artifact',
                body: 'Could not refresh this artifact. Showing the saved copy.',
                route: location.hash,
                needsYou: false,
                current: false,
              },
            ]
          : [],
      ),
  });
}
