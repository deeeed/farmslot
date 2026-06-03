export interface GatewayOriginLocation {
  protocol: string;
  hostname: string;
}

export function gatewayHttpOrigin(locationLike = currentLocation()): string {
  return `${locationLike.protocol}//${locationLike.hostname}:7777`;
}

function currentLocation(): GatewayOriginLocation {
  if (typeof window !== 'undefined') return window.location;
  return { protocol: 'http:', hostname: 'localhost' };
}
