import { type GatewayAuthConnectResult, workspaceAccessFromAuth } from '../rpc/auth.js';
import { Events } from '../transport/events.js';

import type { ResourceReadMethod } from './registry.js';
import { type ResourceStoreIdentity, resourceStoreScopeId } from './store.js';
import type {
  ResourceCacheConnection,
  ResourceCacheTransport,
  ResourceConnectionReason,
  ResourceReadResult,
} from './types.js';

export interface ResourceClientConnection {
  readonly resourceConnectionReason?: ResourceConnectionReason;
  requestResource<T>(
    method: ResourceReadMethod,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<ResourceReadResult<T>>;
  subscribe(event: string, listener: (payload: unknown) => void): () => void;
  onConnectionChange(listener: () => void): () => void;
  reconnect(): void;
}

export interface ResourceConnectionInputs {
  id: string | number;
  connected: boolean;
  foreground?: boolean;
  gatewayUrl: string;
  profileId?: string;
  authentication?: GatewayAuthConnectResult;
  /** Used only while disconnected or before auth; a live reply always replaces it. */
  lastVerified?: ResourceStoreIdentity;
  reason?: ResourceConnectionReason;
}

/** Adapts existing sockets; query dependencies and event-to-query routing remain in the cache. */
export function createResourceCacheTransport(
  client: ResourceClientConnection,
  snapshot: () => ResourceConnectionInputs,
): ResourceCacheTransport {
  function getConnection(): ResourceCacheConnection {
    const state = snapshot();
    const auth = state.authentication;
    const saved =
      !auth &&
      state.lastVerified &&
      resourceStoreScopeId({
        gatewayUrl: state.lastVerified.metadata.scope.gatewayUrl,
        profileId: state.lastVerified.metadata.scope.profileId,
      }) === resourceStoreScopeId({ gatewayUrl: state.gatewayUrl, profileId: state.profileId })
        ? state.lastVerified
        : undefined;
    return {
      id: state.id,
      connected: state.connected,
      foreground: state.foreground,
      authMode: auth?.authMode ?? saved?.authMode ?? 'token',
      scope: {
        ...saved?.metadata.scope,
        gatewayUrl: state.gatewayUrl,
        profileId: state.profileId,
        ...(auth && auth.authMode !== 'none'
          ? { principalId: auth?.principal?.id, principalGeneration: auth?.principal?.generation }
          : {}),
      },
      ...(auth
        ? {
            authority: {
              roles: auth.principal?.roles ?? [],
              workspaceAccess: workspaceAccessFromAuth(auth),
            },
            capabilities: auth.capabilities,
          }
        : saved
          ? { authority: saved.metadata.authority }
          : {}),
    };
  }
  return {
    getConnection,
    onConnectionChange: (listener) =>
      client.onConnectionChange(() =>
        listener(getConnection(), snapshot().reason ?? client.resourceConnectionReason),
      ),
    onResourceChanged: (listener) =>
      client.subscribe(Events.RESOURCE_CHANGED, (payload) =>
        listener(payload as import('../transport/events.js').ResourceChangedPayload),
      ),
    request: (method, params, signal) => client.requestResource(method, params, signal),
    resynchronize: () => client.reconnect(),
  };
}
