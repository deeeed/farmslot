import {
  canonicalResourceJson,
  type GatewayResourceCache,
  normalizeResourceStoreScope,
  type ResourceClientConnection,
  type ResourceConnectionInputs,
  type ResourceConnectionReason,
  type ResourceStore,
  type ResourceStoreIdentity,
  type ResourceStoreMetadata,
  resourceStoreScopeId,
} from '@farmslot/protocol/client-cache';
import { workspaceAccessFromAuth } from '@farmslot/protocol/rpc/auth';

import { createStoredResourceCache, type ResourceIdentityStorage } from './session.js';

export interface ResourceCacheOwnerInput {
  client: ResourceClientConnection | null;
  connection: ResourceConnectionInputs;
  signedOut?: boolean;
}

export interface ResourceCacheOwnerOptions {
  contentBudgetBytes?: number;
  identities(gatewayUrl: string, profileId?: string): ResourceIdentityStorage;
  openStore(
    metadata: ResourceStoreMetadata,
    onNotice: (notice: string | undefined) => void,
  ): Promise<ResourceStore>;
  onNotice(notice: string | undefined): void;
  onError(error: unknown): void;
}

interface OwnedCache {
  client: ResourceClientConnection;
  key: string;
  input: ResourceCacheOwnerInput;
  identity?: string;
  renderIdentity?: ResourceStoreIdentity;
  authentication?: ResourceConnectionInputs['authentication'];
  cache: GatewayResourceCache;
  inputChanges: Set<() => void>;
}

const terminal = new Set<ResourceConnectionReason>([
  'sign-out',
  'principal-change',
  'credential-refused',
  'session-ended',
]);

/** Closes the previous profile synchronously before a socket can report the next one. */
export class ResourceCacheOwner {
  private owned?: OwnedCache;
  private retirement: Promise<void> = Promise.resolve();
  private pendingBinding?: { client: ResourceClientConnection; key: string; id: string | number };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: ResourceCacheOwnerOptions) {}

  get cache(): GatewayResourceCache | undefined {
    return this.owned?.cache;
  }
  /** Navigation may show retained data; RPC authorization still uses the live client. */
  get renderIdentity(): ResourceStoreIdentity | undefined {
    return this.owned?.renderIdentity;
  }
  /** A verified live reply may support in-memory rendering without a persistable generation. */
  get renderMetadata(): ResourceStoreMetadata | undefined {
    const owned = this.owned;
    const auth = owned?.authentication;
    if (!owned || !auth) return owned?.renderIdentity?.metadata;
    return {
      scope: normalizeResourceStoreScope({
        gatewayUrl: owned.input.connection.gatewayUrl,
        profileId: owned.input.connection.profileId,
        ...(auth.authMode === 'none'
          ? {}
          : {
              principalId: auth.principal?.id,
              principalGeneration: auth.principal?.generation,
            }),
      }),
      authority: {
        roles: auth.principal?.roles ?? [],
        workspaceAccess: workspaceAccessFromAuth(auth),
      },
    };
  }
  /** Stable through transport loss; changes only when the rendered owner's scope or roles change. */
  get renderKey(): string | undefined {
    const metadata = this.renderMetadata;
    if (!metadata) return undefined;
    return canonicalResourceJson({
      authMode: this.owned?.authentication?.authMode ?? this.owned?.renderIdentity?.authMode,
      scope: resourceStoreScopeId(metadata.scope),
      access: metadata.authority.workspaceAccess,
      roles: [...new Set(metadata.authority.roles.map(canonicalResourceJson))].sort(),
    });
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private retire(reason: ResourceConnectionReason): void {
    const previous = this.owned;
    if (!previous) return;
    this.owned = undefined;
    // dispose cancels listeners/reads before its first await. New storage awaits the whole cleanup.
    this.retirement = previous.cache.dispose(reason);
    void this.retirement.catch((error: unknown) => this.options.onError(error));
    this.notify();
  }

  update(input: ResourceCacheOwnerInput): void {
    const client = input.client;
    const connection = input.connection;
    const reason = connection.reason ?? client?.resourceConnectionReason;
    const key = JSON.stringify([connection.gatewayUrl, connection.profileId]);
    const auth = connection.connected ? connection.authentication : undefined;
    const identity = auth
      ? JSON.stringify([auth.authMode, auth.principal?.id, auth.principal?.generation])
      : undefined;
    const changed = this.owned && (this.owned.client !== client || this.owned.key !== key);
    if (
      changed &&
      this.owned?.client === client &&
      connection.connected &&
      this.owned.input.connection.id === connection.id
    ) {
      // A profile state update can precede setConnection on the same client and URL.
      this.pendingBinding = { client, key, id: connection.id };
    }
    const principalChanged =
      identity !== undefined &&
      this.owned?.identity !== undefined &&
      identity !== this.owned.identity;
    if (changed || principalChanged || input.signedOut || (reason && terminal.has(reason))) {
      this.retire(
        input.signedOut
          ? 'sign-out'
          : reason && terminal.has(reason)
            ? reason
            : principalChanged
              ? 'principal-change'
              : 'profile-change',
      );
    }
    if (!client || !connection.gatewayUrl || input.signedOut || (reason && terminal.has(reason))) {
      this.pendingBinding = undefined;
      return;
    }
    if (
      this.pendingBinding?.client === client &&
      this.pendingBinding.key === key &&
      this.pendingBinding.id === connection.id &&
      connection.connected
    )
      return;
    this.pendingBinding = undefined;
    if (this.owned) {
      const foregroundChanged = this.owned.input.connection.foreground !== connection.foreground;
      this.owned.input = input;
      if (identity !== undefined) this.owned.identity = identity;
      if (auth) this.owned.authentication = auth;
      if (foregroundChanged) for (const listener of this.owned.inputChanges) listener();
      return;
    }
    // Wait for the previous owner's cleanup, not its success: retire() already reported a failure,
    // such as observer withdrawal on a closed socket, and it must not keep this owner in memory.
    const before = this.retirement.catch(() => undefined);
    const storage = this.options.identities(connection.gatewayUrl, connection.profileId);
    let cache: GatewayResourceCache;
    const owned: OwnedCache = {
      client,
      key,
      input,
      identity,
      authentication: auth,
      inputChanges: new Set(),
      get cache() {
        return cache;
      },
    };
    const onNotice = (notice: string | undefined) => {
      if (this.owned === owned) this.options.onNotice(notice);
    };
    cache = createStoredResourceCache({
      contentBudgetBytes: this.options.contentBudgetBytes,
      client: {
        get resourceConnectionReason() {
          return client.resourceConnectionReason;
        },
        requestResource: (method, params, signal) => client.requestResource(method, params, signal),
        ...(client.replaceResourceObservers
          ? { replaceResourceObservers: client.replaceResourceObservers.bind(client) }
          : {}),
        subscribe: (event, listener) => client.subscribe(event, listener),
        reconnect: () => client.reconnect(),
        onConnectionChange(listener) {
          owned.inputChanges.add(listener);
          const stop = client.onConnectionChange(listener);
          return () => {
            owned.inputChanges.delete(listener);
            stop();
          };
        },
      },
      snapshot: () => owned.input.connection,
      identities: {
        load: async () => {
          await before;
          return storage.load();
        },
        save: async (value) => {
          await before;
          await storage.save(value);
        },
      },
      openStore: async (metadata) => {
        await before;
        return this.options.openStore(metadata, onNotice);
      },
      onNotice,
      onIdentity: (value) => {
        owned.renderIdentity = value;
        if (this.owned === owned) this.notify();
      },
    });
    this.owned = owned;
    this.options.onNotice(undefined);
    this.notify();
  }

  async dispose(reason: ResourceConnectionReason = 'profile-change'): Promise<void> {
    this.retire(reason);
    await this.retirement;
  }
}
