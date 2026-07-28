export interface ConnectionProbeIdentity {
  client: object;
  gatewayUrl: string;
  profileId: string;
  connectionGeneration: number;
}

export type StableConnectionProbeIdentity = Omit<ConnectionProbeIdentity, 'connectionGeneration'>;

export function hasStableConnectionProbeIdentity(
  started: StableConnectionProbeIdentity,
  current: StableConnectionProbeIdentity,
): boolean {
  return (
    started.client === current.client &&
    started.gatewayUrl === current.gatewayUrl &&
    started.profileId === current.profileId
  );
}

export function hasCurrentConnectionProbeTransport(
  started: ConnectionProbeIdentity,
  current: ConnectionProbeIdentity,
): boolean {
  return (
    hasStableConnectionProbeIdentity(started, current) &&
    started.connectionGeneration === current.connectionGeneration
  );
}

export function isCurrentConnectionProbe(
  started: ConnectionProbeIdentity,
  current: ConnectionProbeIdentity,
): boolean {
  return hasCurrentConnectionProbeTransport(started, current);
}
