export interface GatewayAuthCredentials {
  token?: string;
  password?: string;
}

export type GatewayHttpAuthHeaders = Record<string, string>;

export function gatewayHttpAuthHeaders(
  auth: GatewayAuthCredentials = {},
): GatewayHttpAuthHeaders {
  const credential = auth.token?.trim() || auth.password?.trim();
  return credential ? { Authorization: `Bearer ${credential}` } : {};
}

export function gatewayResourceUrl(
  uri: string,
  headers: GatewayHttpAuthHeaders = {},
): string {
  const token = gatewayBearerToken(headers);
  if (!token || hasAuthQueryParam(uri)) return uri;

  const hashIndex = uri.indexOf('#');
  const base = hashIndex >= 0 ? uri.slice(0, hashIndex) : uri;
  const hash = hashIndex >= 0 ? uri.slice(hashIndex) : '';
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}token=${encodeURIComponent(token)}${hash}`;
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
  return fetch(gatewayResourceUrl(uri, headers), {
    ...init,
    headers: {
      ...headers,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function gatewayBearerToken(headers: GatewayHttpAuthHeaders): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'authorization') continue;
    const trimmed = value.trim();
    if (!trimmed.toLowerCase().startsWith('bearer ')) return null;
    const token = trimmed.slice('bearer '.length).trim();
    return token || null;
  }
  return null;
}

function hasAuthQueryParam(uri: string): boolean {
  const queryStart = uri.indexOf('?');
  if (queryStart < 0) return false;
  const hashStart = uri.indexOf('#', queryStart);
  const query = uri.slice(queryStart + 1, hashStart >= 0 ? hashStart : undefined);
  const params = new URLSearchParams(query);
  return params.has('token') || params.has('access_token');
}
