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

/** Browser page context for shaping gateway HTTP URLs (Vite proxy vs hosted /cc). */
export interface GatewayHttpLocation {
  href: string;
  origin: string;
  pathname: string;
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
  // Browser dashboard: WS defaults to same host (/ws via Vite proxy). Keep HTTP on that
  // origin instead of guessing :7777 — dev often runs gateway on another port (7801).
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  return `${locationLike.protocol}//${locationLike.hostname}:7777`;
}

/** Append gateway credentials to same-origin gateway API URLs (query token for img/fetch). */
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

/** Authenticated gateway API URL — alias for gatewayApiUrl. */
export function gatewayAuthenticatedUrl(pathOrUrl: string): string {
  return gatewayApiUrl(pathOrUrl);
}

/** Authenticated URL for img/video/href — same-origin /api proxy in local dev, absolute on hosted /cc. */
export function gatewayResourceUrl(pathOrUrl: string): string {
  return gatewayProxiedFetchUrl(pathOrUrl);
}

export function readGatewayHttpLocation(): GatewayHttpLocation | null {
  if (typeof window === 'undefined') return null;
  return {
    href: window.location.href,
    origin: window.location.origin,
    pathname: window.location.pathname,
  };
}

/**
 * Strip a gateway absolute URL to a same-origin path so dev-mode requests go through
 * Vite's /api proxy. Hosted /cc/ keeps the full gateway URL (UI and gateway differ).
 */
export function sameOriginGatewayHttpUrl(
  url: string,
  locationLike: GatewayHttpLocation | null = readGatewayHttpLocation(),
  gatewayOrigin = gatewayHttpOrigin(),
): string {
  if (!locationLike) return url;
  const hostedCommandCenter =
    locationLike.pathname === '/cc' || locationLike.pathname.startsWith('/cc/');
  try {
    const parsed = new URL(url, locationLike.href);
    if (
      parsed.origin === locationLike.origin ||
      (parsed.origin === gatewayOrigin && !hostedCommandCenter)
    ) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return url;
  } catch {
    return url;
  }
}

/** Authenticated URL shaped for browser fetch() — dev proxy path or hosted absolute URL. */
export function gatewayProxiedFetchUrl(
  pathOrUrl: string,
  locationLike: GatewayHttpLocation | null = readGatewayHttpLocation(),
): string {
  return sameOriginGatewayHttpUrl(gatewayAuthenticatedUrl(pathOrUrl), locationLike);
}

/** fetch() wrapper for gateway /api/* endpoints with auth + dev proxy shaping. */
export function gatewayHttpFetch(
  pathOrUrl: string,
  init?: RequestInit,
  locationLike: GatewayHttpLocation | null = readGatewayHttpLocation(),
): Promise<Response> {
  return fetch(gatewayProxiedFetchUrl(pathOrUrl, locationLike), init);
}

function currentLocation(): GatewayOriginLocation {
  if (typeof window !== 'undefined') return window.location;
  return { protocol: 'http:', hostname: 'localhost' };
}
