import { ResourceCacheOwner, resourceIdentityStorageKey } from '@farmslot/local-store';
import {
  closeBrowserResourceStores,
  createBrowserSqliteResourceStore,
} from '@farmslot/local-store/browser';
import {
  createDraftStore,
  createMemoryDraftStorage,
  type DraftStorage,
  type DraftStore,
  openIndexedDbDraftStorage,
} from '@farmslot/local-store/drafts';
import type { Run } from '@farmslot/protocol';
import {
  type ContentPrefetchTarget,
  createResourceCacheTransport,
  type GatewayResourceCache,
  type ResourceConnectionInputs,
  type ResourceStoreMetadata,
  resourceStoreScopeId,
} from '@farmslot/protocol/client-cache';

import { createOwnerContentPrefetch, fetchRunArtifactBytes } from './content-prefetch.js';
import { gateway } from './gateway-client.js';

let notice: string | undefined;
/** The owned cache whose store is persistent; only this tab's owner store prefetches. */
let persistentCache: GatewayResourceCache | undefined;
let defaultBranch: ((run: Run) => string | undefined) | undefined;
let stopConnection: (() => void) | undefined;
let suspended = false;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
function reportCloseError(error: unknown): void {
  notice = `Offline storage could not close: ${error instanceof Error ? error.message : String(error)}`;
  notify();
}
const owner = new ResourceCacheOwner({
  contentBudgetBytes: 2 * 1024 * 1024 * 1024,
  identities(gatewayUrl, profileId) {
    const key = resourceIdentityStorageKey(gatewayUrl, profileId);
    return {
      load: async () => localStorage.getItem(key),
      save: async (identity) => {
        if (identity) localStorage.setItem(key, JSON.stringify(identity));
        else localStorage.removeItem(key);
      },
    };
  },
  async openStore(metadata, onNotice) {
    const store = await createBrowserSqliteResourceStore({ scope: metadata.scope, onNotice });
    persistentCache = store.persistent ? owner.cache : undefined;
    syncContentPrefetch();
    return store;
  },
  onNotice(value) {
    notice = value;
    notify();
  },
  onError: reportCloseError,
});

function connectionInputs(): ResourceConnectionInputs {
  const connected = gateway.connectionState === 'connected';
  return {
    id: gateway.resourceConnectionId,
    gatewayUrl: gateway.gatewayUrl,
    connected,
    foreground: document.visibilityState !== 'hidden',
    authentication: connected ? gateway.authenticatedConnection : undefined,
    reason: gateway.resourceConnectionReason,
  };
}

const contentPrefetch = createOwnerContentPrefetch({
  transport: createResourceCacheTransport(
    {
      get resourceConnectionReason() {
        return gateway.resourceConnectionReason;
      },
      requestResource: (method, params, signal) => gateway.requestResource(method, params, signal),
      subscribe: (event, listener) => gateway.subscribe(event, listener),
      reconnect: () => gateway.reconnect(),
      onConnectionChange(listener) {
        // A hidden tab pauses prefetch, so visibility counts as a connection change.
        const stop = gateway.onConnectionChange(() => listener());
        document.addEventListener('visibilitychange', listener);
        return () => {
          stop();
          document.removeEventListener('visibilitychange', listener);
        };
      },
    },
    connectionInputs,
  ),
  request: (method, params, signal) => gateway.request(method, params, { signal }),
  readArtifact: fetchRunArtifactBytes,
  defaultBranch: (run) => defaultBranch?.(run),
});
function syncContentPrefetch(): void {
  contentPrefetch.sync(owner.cache, owner.cache !== undefined && owner.cache === persistentCache);
}
let draftStorage: Promise<DraftStorage> | undefined;
let drafts: Promise<DraftStore> | undefined;
let deletedDrafts = 0;
/** The scope this document last checked for other principals' drafts. */
let draftScopeChecked: string | undefined;

/** The gateway profile a drafts scope id belongs to, whichever principal holds it. */
function draftProfile(scopeId: string): string | undefined {
  try {
    const scope: unknown = JSON.parse(scopeId);
    const gatewayUrl = scope && typeof scope === 'object' && Reflect.get(scope, 'gatewayUrl');
    if (typeof gatewayUrl !== 'string') return undefined;
    const profileId = Reflect.get(scope as object, 'profileId');
    return resourceStoreScopeId({
      gatewayUrl,
      ...(typeof profileId === 'string' ? { profileId } : {}),
    });
  } catch {
    return undefined;
  }
}

/**
 * Drafts rule 6: the first authenticated connect in this document, and every change of principal
 * after it, deletes the drafts other principals left on the same gateway profile, in this tab or
 * another one, and says how many were unsaved. A reconnect as the same principal checks nothing,
 * so a tab still holding an older login never deletes the drafts of the principal another tab
 * has since signed in as.
 */
function retireOtherPrincipalDrafts(): void {
  const metadata = owner.renderMetadata;
  if (!metadata || gateway.connectionState !== 'connected' || !gateway.authenticatedConnection)
    return;
  const scopeId = resourceStoreScopeId(metadata.scope);
  if (draftScopeChecked === scopeId) return;
  draftScopeChecked = scopeId;
  const profile = draftProfile(scopeId);
  void Promise.all([editorDraftStorage(), getEditorDrafts()])
    .then(async ([storage, store]) => {
      const others = new Set(
        (await storage.list())
          .map((draft) => draft.scopeId)
          .filter((other) => other !== scopeId && draftProfile(other) === profile),
      );
      let unsaved = 0;
      for (const other of others) {
        unsaved += await store.countUnsaved(other);
        await store.deleteScope(other);
      }
      if (unsaved === 0) return;
      deletedDrafts += unsaved;
      notify();
    })
    .catch(reportCloseError);
}

owner.subscribe(() => {
  syncContentPrefetch();
  retireOtherPrincipalDrafts();
  notify();
});

function sync(): void {
  if (suspended) return;
  owner.update({ client: gateway, connection: connectionInputs() });
  retireOtherPrincipalDrafts();
}

function suspendForNavigation(): void {
  suspended = true;
  // Retire observations before stopping the worker. Chromium can otherwise
  // destroy its OPFS remotes while a queued synchronous write is still running.
  const retiring = owner.dispose();
  closeBrowserResourceStores();
  void retiring.catch(reportCloseError);
}

function resumeFromNavigation(event: PageTransitionEvent): void {
  if (!event.persisted || !suspended) return;
  suspended = false;
  // A restored document must reauthenticate and read on a new connection.
  gateway.reconnect();
  sync();
}

export function initializeResourceCache(): void {
  if (stopConnection) return;
  suspended = false;
  window.addEventListener('pagehide', suspendForNavigation);
  window.addEventListener('pageshow', resumeFromNavigation);
  document.addEventListener('visibilitychange', sync);
  stopConnection = gateway.onConnectionChange(sync);
  sync();
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
export function getResourceStoreMetadata(): ResourceStoreMetadata | undefined {
  return owner.renderMetadata;
}
export function getResourceStoreNotice(): string | undefined {
  return owner.cache ? notice : undefined;
}

function editorDraftStorage(): Promise<DraftStorage> {
  draftStorage ??=
    typeof indexedDB === 'undefined'
      ? Promise.resolve(createMemoryDraftStorage())
      : openIndexedDbDraftStorage().catch(() => createMemoryDraftStorage());
  return draftStorage;
}
/** Unsaved editor drafts: IndexedDB shared by every tab, outside the rebuildable resource store. */
export function getEditorDrafts(): Promise<DraftStore> {
  drafts ??= editorDraftStorage().then((storage) => createDraftStore(storage));
  return drafts;
}
/** The rendered owner's drafts scope: its gateway profile and principal generation. */
export function getEditorDraftScopeId(): string | undefined {
  const metadata = owner.renderMetadata;
  return metadata ? resourceStoreScopeId(metadata.scope) : undefined;
}
/** Unsaved drafts a principal change deleted, until the notice is dismissed. */
export function getDeletedDraftCount(): number {
  return deletedDrafts;
}
export function dismissDeletedDraftNotice(): void {
  deletedDrafts = 0;
  notify();
}
/** Pending gates and active runs, from the shared observations; nothing polls. */
export function setContentPrefetchTargets(
  targets: readonly ContentPrefetchTarget[],
  runDefaultBranch?: (run: Run) => string | undefined,
): void {
  defaultBranch = runDefaultBranch;
  contentPrefetch.setTargets(targets);
}
export function subscribeResourceCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function disposeResourceCache(): Promise<void> {
  stopConnection?.();
  stopConnection = undefined;
  window.removeEventListener('pagehide', suspendForNavigation);
  window.removeEventListener('pageshow', resumeFromNavigation);
  document.removeEventListener('visibilitychange', sync);
  suspended = false;
  const retiring = owner.dispose();
  closeBrowserResourceStores();
  await retiring;
}

/** Last verified owner for native query dependencies, also available during cold offline render. */
export function getResourceNativeOwnerId(): string | undefined {
  return owner.renderMetadata?.scope.principalId;
}
