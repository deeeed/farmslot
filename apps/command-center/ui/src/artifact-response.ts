import { readStoredArtifactResponse } from '@farmslot/protocol/client-cache';

import { gatewayHttpFetch, gatewayHttpOrigin } from './utils/gateway-origin.js';
import { notificationTray } from './utils/notification-tray.js';
import { gateway } from './gateway-client.js';
import { CONTENT_MISMATCH, openHeldContent, readVerifiedContent } from './held-content.js';
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

const MAX_PREVIEW_BYTES = 512 * 1024;

/** Bounded artifact preview, verified by the selected manifest SHA before storage/display. */
export async function readVerifiedArtifactPreview(
  url: string,
  sha256: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const key = { kind: 'artifact' as const, id: sha256 };
  let bytes = await openHeldContent(key);
  if (!bytes) {
    const verified = await readVerifiedContent(
      key,
      async () => {
        const response = await gatewayHttpFetch(url, { signal });
        if (!response.ok || !response.body) throw Error(`File unavailable (${response.status}).`);
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_PREVIEW_BYTES) throw Error('File is too large to preview.');
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return body;
      },
      'run',
    );
    if (verified === CONTENT_MISMATCH) throw Error('File changed; search again.');
    bytes = verified;
  }
  if (bytes.byteLength > MAX_PREVIEW_BYTES) throw Error('File is too large to preview.');
  return bytes;
}
