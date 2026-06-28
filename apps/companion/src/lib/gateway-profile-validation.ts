export const LEGACY_LOCALHOST_GATEWAY_URLS = new Set([
  'ws://localhost:7777/ws',
  'ws://127.0.0.1:7777/ws',
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export function isValidGatewayUrl(url: string): boolean {
  return url.startsWith('ws://') || url.startsWith('wss://');
}

export function isLegacyLocalhostGatewayUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (LEGACY_LOCALHOST_GATEWAY_URLS.has(url)) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'ws:' && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    // Invalid URLs are handled by isValidGatewayUrl/mobileGatewayProfileUrlError;
    // they are not classified as legacy localhost profiles.
    return false;
  }
}

function isRecipeBridgeLoopbackGatewayEnabled(): boolean {
  return process.env.EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE === '1';
}

export function isMobileGatewayProfileUrl(url: string): boolean {
  if (!isValidGatewayUrl(url)) return false;
  if (isRecipeBridgeLoopbackGatewayEnabled() && isLegacyLocalhostGatewayUrl(url)) {
    // iOS Simulator recipe proof reaches the host loopback gateway via Metro dev-client.
    return true;
  }
  return !isLegacyLocalhostGatewayUrl(url);
}

export function mobileGatewayProfileUrlError(url: string): string | null {
  if (!isValidGatewayUrl(url)) return 'Gateway URL must start with ws:// or wss://';
  if (isLegacyLocalhostGatewayUrl(url) && !isRecipeBridgeLoopbackGatewayEnabled()) {
    return 'Mobile profiles cannot use localhost. Use your Mac LAN hostname, a LAN IP, tailnet DNS, or WSS remote URL.';
  }
  return null;
}
