import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

import { ResourceCacheOwner, resourceIdentityStorageKey } from '@farmslot/local-store';
import { createNativeSqliteResourceStore } from '@farmslot/local-store/native';
import {
  createResourceCacheTransport,
  type GatewayResourceCache,
  type ResourceConnectionInputs,
} from '@farmslot/protocol/client-cache';

import { useConnectionStore } from '../store/connection';

import { artifactUrl, setHeldArtifactLookup } from './artifact-url';
import { startContentPrefetch } from './content-prefetch';
import { createEvidenceMediaHolder } from './evidence-media';
import { nativeEvidenceMediaFiles } from './evidence-media-files';
import { gatewayResourceSource } from './gateway-http-auth';
import { fetchRunArtifactBytes } from './held-content';

let notice: string | undefined;
let prefetch: { cache: GatewayResourceCache; farm: boolean; stop: () => void } | undefined;
let stopStore: (() => void) | undefined;
let stopAppState: (() => void) | undefined;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const owner = new ResourceCacheOwner({
  contentBudgetBytes: 500 * 1024 * 1024,
  identities(gatewayUrl, profileId) {
    const key = resourceIdentityStorageKey(gatewayUrl, profileId);
    return {
      load: () => AsyncStorage.getItem(key),
      save: async (identity) => {
        if (identity) await AsyncStorage.setItem(key, JSON.stringify(identity));
        else await AsyncStorage.removeItem(key);
      },
    };
  },
  openStore: (metadata) => createNativeSqliteResourceStore({ scope: metadata.scope }),
  onNotice(value) {
    notice = value;
    notify();
  },
  onError(error) {
    notice = `Offline storage could not close: ${error instanceof Error ? error.message : String(error)}`;
    notify();
  },
});
owner.subscribe(notify);
owner.subscribe(bindPrefetch);

/**
 * Pending gates' videos and large images, kept as files by digest. They download only on a LAN
 * route: without a network-type API in this binary, that is how the app knows it is on Wi-Fi.
 */
const evidenceMedia = createEvidenceMediaHolder({
  files: nativeEvidenceMediaFiles(),
  source(entry) {
    const state = useConnectionStore.getState();
    return gatewayResourceSource(
      artifactUrl(
        state.gatewayUrl,
        entry.runId,
        entry.path,
        undefined,
        undefined,
        entry.bundleDigest,
      ),
      state.activeProfileHttpAuthHeaders,
    );
  },
  allowed() {
    const state = useConnectionStore.getState();
    return state.profiles.find((profile) => profile.id === state.activeProfileId)?.kind === 'lan';
  },
  log: (message) => console.info(message),
});
setHeldArtifactLookup(evidenceMedia.localUri);

function connectionInputs(): ResourceConnectionInputs {
  const state = useConnectionStore.getState();
  const client = state.client;
  const connected =
    client?.connectionState === 'connected' && client.gatewayUrl === state.gatewayUrl;
  return {
    id: client?.connectionGeneration ?? 0,
    connected,
    foreground: AppState.currentState === 'active',
    gatewayUrl: state.gatewayUrl,
    profileId: state.activeProfileId || undefined,
    authentication: connected ? client?.authenticatedConnection : undefined,
    reason: client?.resourceConnectionReason,
  };
}

function sync(): void {
  const state = useConnectionStore.getState();
  if (state.signedOut) void evidenceMedia.keep(new Set());
  owner.update({
    client: state.client,
    signedOut: state.signedOut,
    connection: connectionInputs(),
  });
  // Authentication can change farm access without a new cache.
  bindPrefetch();
}

/**
 * One content prefetcher per persistent cache; it stops when that cache is retired. Farm access
 * decides whether it can read the projects' default branches, so a change restarts it.
 */
function bindPrefetch(): void {
  const cache = owner.cache;
  const farm = getResourceWorkspaceAccess() === 'farm';
  if (prefetch ? prefetch.cache === cache && prefetch.farm === farm : !cache) return;
  prefetch?.stop();
  prefetch = undefined;
  const client = useConnectionStore.getState().client;
  if (!cache || !client) return;
  prefetch = {
    cache,
    farm,
    stop: startContentPrefetch({
      cache,
      farm,
      media: evidenceMedia,
      transport: createResourceCacheTransport(client, connectionInputs),
      request: (method, params, signal) => client.request(method, params, undefined, { signal }),
      readArtifact(artifact, signal) {
        const state = useConnectionStore.getState();
        return fetchRunArtifactBytes(
          state.gatewayUrl,
          state.activeProfileHttpAuthHeaders,
          artifact,
          signal,
        );
      },
    }),
  };
}

export function initializeNativeResourceCache(): () => void {
  if (stopStore) return () => {};
  stopStore = useConnectionStore.subscribe(sync);
  const appState = AppState.addEventListener('change', sync);
  stopAppState = () => appState.remove();
  sync();
  return () => {
    stopStore?.();
    stopStore = undefined;
    stopAppState?.();
    stopAppState = undefined;
    void owner.dispose().catch((error: unknown) => {
      notice = `Offline storage could not close: ${error instanceof Error ? error.message : String(error)}`;
      notify();
    });
  };
}

export function getResourceCache(): GatewayResourceCache | undefined {
  return owner.cache;
}
export function getResourceWorkspaceAccess(): 'farm' | 'native' | 'none' {
  return owner.renderMetadata?.authority.workspaceAccess ?? 'none';
}
export function getResourceWorkspaceKey(): string | undefined {
  return owner.renderKey;
}
export function getResourceStoreNotice(): string | undefined {
  return owner.cache ? notice : undefined;
}
export function subscribeResourceCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Last verified owner for native query dependencies, also available during cold offline render. */
export function getResourceNativeOwnerId(): string | undefined {
  return owner.renderMetadata?.scope.principalId;
}
