import {
  normalizeResourceStoreScope,
  type ResourceCacheConnection,
  type ResourceStoreIdentity,
  resourceStoreScopeId,
} from '@farmslot/protocol/client-cache';
import type { RoleBinding } from '@farmslot/protocol/rpc/principal';

export function resourceIdentityStorageKey(gatewayUrl: string, profileId?: string): string {
  return `farmslot-resource-identity:${resourceStoreScopeId({ gatewayUrl, profileId })}`;
}

/** Persist only verified scope and authority, never the socket's credentials or access tokens. */
export function resourceIdentityFromConnection(
  connection: ResourceCacheConnection,
): ResourceStoreIdentity | undefined {
  if (!connection.connected || !connection.authority) return undefined;
  const normalized = normalizeResourceStoreScope(connection.scope);
  if (
    connection.authMode !== 'none' &&
    (!normalized.principalId ||
      !Number.isSafeInteger(normalized.principalGeneration) ||
      normalized.principalGeneration! < 0)
  )
    return undefined;
  return {
    authMode: connection.authMode,
    metadata: {
      scope: {
        gatewayUrl: normalized.gatewayUrl,
        profileId: normalized.profileId,
        ...(connection.authMode === 'none'
          ? {}
          : {
              principalId: normalized.principalId,
              principalGeneration: normalized.principalGeneration,
            }),
      },
      authority: {
        workspaceAccess: connection.authority.workspaceAccess,
        roles: connection.authority.roles.map((binding) => ({
          role: binding.role,
          scope: { kind: binding.scope.kind },
        })),
      },
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseResourceStoreIdentity(
  raw: string | null,
  gatewayUrl: string,
  profileId?: string,
): ResourceStoreIdentity | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    // This identity is a disposable cache. Live authentication rebuilds corrupt local metadata.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (
    !record(value) ||
    !['token', 'password', 'none'].includes(String(value.authMode)) ||
    !record(value.metadata)
  )
    return undefined;
  const scope = value.metadata.scope;
  const authority = value.metadata.authority;
  if (
    !record(scope) ||
    typeof scope.gatewayUrl !== 'string' ||
    (scope.profileId !== undefined && typeof scope.profileId !== 'string') ||
    !record(authority) ||
    !['farm', 'native', 'none'].includes(String(authority.workspaceAccess)) ||
    !Array.isArray(authority.roles)
  )
    return undefined;
  const roles: RoleBinding[] = [];
  for (const role of authority.roles) {
    if (
      !record(role) ||
      (role.role !== 'admin' && role.role !== 'operator') ||
      !record(role.scope) ||
      role.scope.kind !== 'global'
    )
      return undefined;
    roles.push({ role: role.role, scope: { kind: 'global' } });
  }
  let storedProfile: string;
  try {
    storedProfile = resourceStoreScopeId({
      gatewayUrl: scope.gatewayUrl,
      profileId: scope.profileId,
    });
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
  if (storedProfile !== resourceStoreScopeId({ gatewayUrl, profileId })) return undefined;
  const authMode = value.authMode as ResourceStoreIdentity['authMode'];
  if (
    authMode !== 'none' &&
    (typeof scope.principalId !== 'string' ||
      !scope.principalId ||
      !Number.isSafeInteger(scope.principalGeneration) ||
      Number(scope.principalGeneration) < 0)
  )
    return undefined;
  return {
    authMode,
    metadata: {
      scope: {
        gatewayUrl: normalizeResourceStoreScope({ gatewayUrl }).gatewayUrl,
        profileId,
        ...(authMode === 'none'
          ? {}
          : {
              principalId: scope.principalId as string,
              principalGeneration: scope.principalGeneration as number,
            }),
      },
      authority: {
        roles,
        workspaceAccess:
          authority.workspaceAccess as ResourceStoreIdentity['metadata']['authority']['workspaceAccess'],
      },
    },
  };
}
