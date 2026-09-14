import type { GatewayClient } from './gateway-client';

/** Capture before a request so a later profile/authentication cannot adopt its result. */
export function currentFarmConnection(
  client: Pick<
    GatewayClient,
    'connectionGeneration' | 'connectionState' | 'authenticatedPrincipal' | 'workspaceAccess'
  >,
) {
  const generation = client.connectionGeneration;
  const principalId = client.authenticatedPrincipal?.id;
  return () =>
    client.connectionState === 'connected' &&
    client.workspaceAccess === 'farm' &&
    client.connectionGeneration === generation &&
    client.authenticatedPrincipal?.id === principalId;
}
