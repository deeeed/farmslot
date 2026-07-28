export interface ConnectionProbeIdentity {
  client: object;
  gatewayUrl: string;
  connectionGeneration: number;
}

export function isCurrentConnectionProbe(
  started: ConnectionProbeIdentity,
  current: ConnectionProbeIdentity,
): boolean {
  return (
    started.client === current.client &&
    started.gatewayUrl === current.gatewayUrl &&
    started.connectionGeneration === current.connectionGeneration
  );
}
