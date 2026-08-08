export interface GatewayAuthCredentials {
  token?: string;
  password?: string;
}

export type GatewayHttpAuthHeaders = Record<string, string>;

export function gatewayHttpAuthHeaders(auth: GatewayAuthCredentials = {}): GatewayHttpAuthHeaders {
  const token = auth.token?.trim();
  if (token) return { Authorization: `Bearer ${token}` };
  const password = auth.password?.trim();
  return password ? { Authorization: `Basic ${encodeBasicPassword(password)}` } : {};
}

export function gatewayResourceUrl(uri: string, headers: GatewayHttpAuthHeaders = {}): string {
  const credential = gatewayQueryCredential(headers);
  if (!credential || hasAuthQueryParam(uri)) return uri;

  const hashIndex = uri.indexOf('#');
  const base = hashIndex >= 0 ? uri.slice(0, hashIndex) : uri;
  const hash = hashIndex >= 0 ? uri.slice(hashIndex) : '';
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${credential.name}=${encodeURIComponent(credential.value)}${hash}`;
}

export function gatewayResourceSource(
  uri: string,
  headers: GatewayHttpAuthHeaders = {},
): { uri: string; headers?: GatewayHttpAuthHeaders } {
  const sourceUri = gatewayResourceUrl(uri, headers);
  return Object.keys(headers).length > 0 ? { uri: sourceUri, headers } : { uri: sourceUri };
}

export function gatewayFetch(
  uri: string,
  headers: GatewayHttpAuthHeaders = {},
  init: RequestInit = {},
): Promise<Response> {
  // Header-only: fetch fully supports request headers, so the bearer token must
  // never leak into the URL here (where it could land in proxy/request logs or
  // RN network inspectors). URL-token injection (gatewayResourceUrl /
  // gatewayResourceSource) is reserved for header-incapable consumers — RN
  // <Image>/Source — that cannot send an Authorization header.
  return fetch(uri, {
    ...init,
    headers: {
      ...headers,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function gatewayQueryCredential(
  headers: GatewayHttpAuthHeaders,
): { name: 'token' | 'password'; value: string } | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'authorization') continue;
    const trimmed = value.trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      const token = trimmed.slice('bearer '.length).trim();
      return token ? { name: 'token', value: token } : null;
    }
    if (trimmed.toLowerCase().startsWith('basic ')) {
      const password = decodeBasicPassword(trimmed.slice('basic '.length).trim());
      return password ? { name: 'password', value: password } : null;
    }
    return null;
  }
  return null;
}

function hasAuthQueryParam(uri: string): boolean {
  const queryStart = uri.indexOf('?');
  if (queryStart < 0) return false;
  const hashStart = uri.indexOf('#', queryStart);
  const query = uri.slice(queryStart + 1, hashStart >= 0 ? hashStart : undefined);
  const params = new URLSearchParams(query);
  return params.has('token') || params.has('password');
}

function encodeBasicPassword(password: string): string {
  const bytes = new TextEncoder().encode(`:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBasicPassword(value: string): string | null {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const separator = decoded.indexOf(':');
    const password = (separator >= 0 ? decoded.slice(separator + 1) : decoded).trim();
    return password || null;
  } catch (error) {
    // User-provided connection profiles can contain malformed auth headers; those
    // headers cannot produce a usable resource credential.
    if (error instanceof Error) return null;
    throw error;
  }
}
