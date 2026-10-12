import type { GatewayClient } from './gateway-client';

interface FarmAuthority {
  client: GatewayClient | null;
  activeProfileId: string | null;
  authorityEpoch: number;
}

/** Capture before a request so a later profile/authentication cannot adopt its result. */
export function currentFarmConnection(
  client: Pick<
    GatewayClient,
    'connectionGeneration' | 'connectionState' | 'authenticatedPrincipal' | 'workspaceAccess'
  >,
  readAuthority?: () => FarmAuthority,
) {
  const generation = client.connectionGeneration;
  const principalId = client.authenticatedPrincipal?.id;
  const authority = readAuthority?.();
  const profileId = authority?.activeProfileId;
  const epoch = authority?.authorityEpoch;
  return () => {
    const current = readAuthority?.();
    return (
      (!authority ||
        (current?.client === client &&
          current.activeProfileId === profileId &&
          current.authorityEpoch === epoch)) &&
      client.connectionState === 'connected' &&
      client.workspaceAccess === 'farm' &&
      client.connectionGeneration === generation &&
      client.authenticatedPrincipal?.id === principalId
    );
  };
}
