export interface BrowserLocationLike {
  host: string;
  protocol: string;
}

export function resolveGatewayWebSocketUrl(
  configuredUrl: string | undefined,
  currentLocation: BrowserLocationLike,
): string {
  const trimmedUrl = configuredUrl?.trim();
  if (trimmedUrl) return trimmedUrl;
  const protocol = currentLocation.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${currentLocation.host}/ws`;
}
