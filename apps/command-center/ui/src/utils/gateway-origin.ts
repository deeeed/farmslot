import {
  GATEWAY_PASSWORD_STORAGE_KEY,
  GATEWAY_TOKEN_STORAGE_KEY,
  GATEWAY_URL_STORAGE_KEY,
  gatewayWebSocketToHttpOrigin,
} from '../gateway-url.js';

export interface GatewayOriginLocation {
  protocol: string;
  hostname: string;
}

export function gatewayHttpOrigin(locationLike = currentLocation()): string {
  const stored =
    typeof localStorage !== 'undefined' ? localStorage.getItem(GATEWAY_URL_STORAGE_KEY) : null;
  if (stored) {
    try {
      return gatewayWebSocketToHttpOrigin(stored);
    } catch {
      // Stored gateway URLs are user-editable; ignore malformed values and use the local default.
    }
  }
  return `${locationLike.protocol}//${locationLike.hostname}:7777`;
}

export function gatewayApiUrl(path: string): string {
  const gatewayOrigin = gatewayHttpOrigin();
  const absolute =
    path.startsWith('http://') || path.startsWith('https://')
      ? new URL(path)
      : new URL(path, gatewayOrigin);
  const credential =
    typeof localStorage !== 'undefined' ? localStorage.getItem(GATEWAY_TOKEN_STORAGE_KEY) : null;
  const fallbackPassword =
    typeof localStorage !== 'undefined' ? localStorage.getItem(GATEWAY_PASSWORD_STORAGE_KEY) : null;
  const queryCredential = credential ?? fallbackPassword;
  if (absolute.origin === gatewayOrigin && queryCredential && !absolute.searchParams.has('token')) {
    absolute.searchParams.set('token', queryCredential);
  }
  return absolute.toString();
}

function currentLocation(): GatewayOriginLocation {
  if (typeof window !== 'undefined') return window.location;
  return { protocol: 'http:', hostname: 'localhost' };
}
