import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

import { ResourceCacheOwner, resourceIdentityStorageKey } from '@farmslot/local-store';
import { createNativeSqliteResourceStore } from '@farmslot/local-store/native';
import {
  createResourceCacheTransport,
  type GatewayResourceCache,
  type ResourceConnectionInputs,
  resourceStoreScopeId,
} from '@farmslot/protocol/client-cache';

import { useConnectionStore } from '../store/connection';

import { artifactUrl, setHeldArtifactLookup } from './artifact-url';
import { startContentPrefetch } from './content-prefetch';
import { createEvidenceMediaHolder, type EvidenceMediaHolder } from './evidence-media';
import { nativeEvidenceMediaFiles } from './evidence-media-files';
import { gatewayResourceSource } from './gateway-http-auth';
import { fetchRunArtifactBytes } from './held-content';

let notice: string | undefined;
let prefetch:
  | { cache: GatewayResourceCache; farm: boolean; media?: EvidenceMediaHolder; stop: () => void }
  | undefined;
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
  openStore: (metadata) =>
    createNativeSqliteResourceStore({ scope: metadata.scope, deleteFiles: deleteScopeMedia }),
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
owner.subscribe(bindMedia);
owner.subscribe(bindPrefetch);

/**
 * Pending gates' videos and large images, kept as files by digest for the rendered offline store
 * scope and deleted with it (ADR-071). They download only on a LAN route: without a network-type
 * API in this binary, that is how the app knows it is on Wi-Fi.
 */
let media: { scope: string; holder: EvidenceMediaHolder } | undefined;

function scopeMedia(scopeId: string): EvidenceMediaHolder {
  return createEvidenceMediaHolder({
    files: nativeEvidenceMediaFiles(scopeId),
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
}

/** One holder per rendered store scope; a profile switch keeps the previous scope's files. */
function bindMedia(): void {
  const scope = useConnectionStore.getState().signedOut ? undefined : owner.renderMetadata?.scope;
  const scopeId = scope ? resourceStoreScopeId(scope) : undefined;
  if (media?.scope === scopeId) return;
  media?.holder.dispose();
  media = scopeId ? { scope: scopeId, holder: scopeMedia(scopeId) } : undefined;
  setHeldArtifactLookup(media?.holder);
}

/**
 * A deleted offline store takes its scope's held evidence with it, however it was retired. The
 * store awaits this, so a failure fails the deletion and the owner deletes the scope again.
 */
async function deleteScopeMedia(scopeId: string): Promise<void> {
  const current = media?.scope === scopeId ? media.holder : undefined;
  if (current) {
    media = undefined;
    setHeldArtifactLookup(undefined);
  }
  try {
    if (current) await current.destroy();
    else {
      await nativeEvidenceMediaFiles(scopeId).clear();
      console.info('[evidence-media] cleared');
    }
  } catch (error) {
    console.warn('[evidence-media] delete failed', error);
    throw error;
  }
}

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
  owner.update({
    client: state.client,
    signedOut: state.signedOut,
    connection: connectionInputs(),
  });
  bindMedia();
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
  const holder = media?.holder;
  if (
    prefetch
      ? prefetch.cache === cache && prefetch.farm === farm && prefetch.media === holder
      : !cache
  )
    return;
  prefetch?.stop();
  prefetch = undefined;
  const client = useConnectionStore.getState().client;
  if (!cache || !client) return;
  prefetch = {
    cache,
    farm,
    media: holder,
    stop: startContentPrefetch({
      cache,
      farm,
      media: holder,
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
