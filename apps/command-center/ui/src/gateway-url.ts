export interface BrowserLocationLike {
  host: string;
  protocol: string;
  hash?: string;
}

export interface HostedGatewayCandidate {
  url: string;
  label?: string;
}

export interface HostedGatewayConnection {
  urls: string[];
  token?: string;
  password?: string;
}

export type GatewayConnectionSource = 'configured' | 'hosted' | 'stored' | 'implicit';

export const GATEWAY_URL_STORAGE_KEY = 'farmslot.gateway.url';
export const GATEWAY_CANDIDATES_STORAGE_KEY = 'farmslot.gateway.candidates';
export const GATEWAY_TOKEN_STORAGE_KEY = 'farmslot.gateway.token';
export const GATEWAY_PASSWORD_STORAGE_KEY = 'farmslot.gateway.password';
export const GATEWAY_SOURCE_STORAGE_KEY = 'farmslot.gateway.source';

interface HostedGatewayPayload {
  v?: number;
  url?: string;
  gatewayUrl?: string;
  gateways?: Array<string | HostedGatewayCandidate>;
  token?: string;
  password?: string;
}

export function resolveGatewayWebSocketUrl(
  configuredUrl: string | undefined,
  currentLocation: BrowserLocationLike,
): string {
  return resolveGatewayWebSocketUrls(configuredUrl, currentLocation)[0];
}

export function resolveGatewayWebSocketUrls(
  configuredUrl: string | undefined,
  currentLocation: BrowserLocationLike,
  storedCandidates?: string | null,
  storedGatewayUrl?: string | null,
): string[] {
  const trimmedUrl = configuredUrl?.trim();
  if (trimmedUrl) return [normalizeGatewayWebSocketUrl(trimmedUrl)];

  const hosted = parseHostedGatewayConnection(currentLocation.hash ?? '');
  if (hosted.urls.length > 0) return hosted.urls;

  const stored = [
    ...parseStoredGatewayUrl(storedGatewayUrl),
    ...parseStoredGatewayCandidates(storedCandidates),
  ];
  if (stored.length > 0) return [...new Set(stored)];

  return [defaultGatewayWebSocketUrl(currentLocation)];
}

export function resolveGatewayConnectionSource(
  configuredUrl: string | undefined,
  currentLocation: BrowserLocationLike,
  storedCandidates?: string | null,
  storedGatewayUrl?: string | null,
  storedSource?: string | null,
): GatewayConnectionSource {
  if (configuredUrl?.trim()) return 'configured';
  if (parseHostedGatewayConnection(currentLocation.hash ?? '').urls.length > 0) return 'hosted';

  const implicit = defaultGatewayWebSocketUrl(currentLocation);
  const stored = [
    ...parseStoredGatewayCandidates(storedCandidates),
    ...parseStoredGatewayUrl(storedGatewayUrl),
  ];
  if (storedSource === 'stored' && stored.length > 0) return 'stored';
  return stored.some((url) => url !== implicit) ? 'stored' : 'implicit';
}

export function parseHostedGatewayConnection(hash: string): HostedGatewayConnection {
  const encoded = findHashParam(hash, 'connect')?.trim();
  if (!encoded) return { urls: [] };
  try {
    const decoded = decodeBase64UrlJson(encoded);
    const payload = JSON.parse(decoded) as HostedGatewayPayload;
    const urls = normalizePayloadUrls(payload);
    return {
      urls,
      ...(payload.token?.trim() ? { token: payload.token.trim() } : {}),
      ...(payload.password?.trim() ? { password: payload.password.trim() } : {}),
    };
  } catch {
    // The hosted URL fragment is user-pasteable and may be stale/corrupt; fall back to normal discovery.
    return { urls: [] };
  }
}

export function normalizeGatewayWebSocketUrl(url: string): string {
  const parsed = new URL(url.trim());
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`Gateway URL must start with ws://, wss://, http://, or https://: ${url}`);
  }
  if (parsed.pathname === '/' || parsed.pathname === '') parsed.pathname = '/ws';
  return parsed.toString();
}

/**
 * From an HTTPS page the browser blocks every insecure ws:// connection as mixed content.
 * Chrome 150 removed the previous localhost/127.0.0.1 exemption, so a ws:// candidate can
 * never connect from an https origin regardless of host — attempting it only produces a
 * Mixed Content error and a dead retry. (wss:// is always fine; from an http origin nothing
 * is blocked.)
 */
export function isInsecureWebSocketBlocked(
  wsUrl: string,
  currentLocation: BrowserLocationLike,
): boolean {
  if (currentLocation.protocol !== 'https:') return false;
  let parsed: URL;
  try {
    parsed = new URL(wsUrl);
  } catch {
    return false;
  }
  return parsed.protocol === 'ws:';
}

/**
 * Split gateway candidates into those the browser can actually reach from the current page
 * and those it will refuse as mixed content. When every candidate is blocked (the common
 * "hosted https CC → local ws:// gateway" case), the caller surfaces a first-class
 * explanation rather than spinning through a doomed reconnect loop.
 */
export function filterConnectableGatewayUrls(
  urls: string[],
  currentLocation: BrowserLocationLike,
): { connectable: string[]; blocked: string[] } {
  const connectable: string[] = [];
  const blocked: string[] = [];
  for (const url of urls) {
    if (isInsecureWebSocketBlocked(url, currentLocation)) blocked.push(url);
    else connectable.push(url);
  }
  return { connectable, blocked };
}

export function gatewayWebSocketToHttpOrigin(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

export function persistGatewayAuthForHttp(auth: { token?: string; password?: string }): void {
  if (typeof localStorage === 'undefined') return;

  const token = auth.token?.trim();
  const password = auth.password?.trim();
  if (token) {
    localStorage.setItem(GATEWAY_TOKEN_STORAGE_KEY, token);
    localStorage.removeItem(GATEWAY_PASSWORD_STORAGE_KEY);
    return;
  }
  if (password) {
    localStorage.setItem(GATEWAY_PASSWORD_STORAGE_KEY, password);
    localStorage.removeItem(GATEWAY_TOKEN_STORAGE_KEY);
  }
}

export function replaceStoredGatewayAuthForHttp(auth: { token?: string; password?: string }): void {
  if (typeof localStorage === 'undefined') return;

  localStorage.removeItem(GATEWAY_TOKEN_STORAGE_KEY);
  localStorage.removeItem(GATEWAY_PASSWORD_STORAGE_KEY);
  persistGatewayAuthForHttp(auth);
}

function defaultGatewayWebSocketUrl(currentLocation: BrowserLocationLike): string {
  const protocol = currentLocation.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${currentLocation.host}/ws`;
}

function normalizePayloadUrls(payload: HostedGatewayPayload): string[] {
  const raw: string[] = [];
  if (payload.gatewayUrl) raw.push(payload.gatewayUrl);
  if (payload.url) raw.push(payload.url);
  for (const entry of payload.gateways ?? []) {
    raw.push(typeof entry === 'string' ? entry : entry.url);
  }
  return [...new Set(raw.map((url) => normalizeGatewayWebSocketUrl(url)))];
}

function parseStoredGatewayUrl(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  try {
    return [normalizeGatewayWebSocketUrl(value)];
  } catch {
    // Stored URLs are cache-only; bad localStorage should not break page load.
    return [];
  }
}

function parseStoredGatewayCandidates(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map(normalizeGatewayWebSocketUrl);
  } catch {
    // Stored candidates are cache-only; bad localStorage should not break page load.
    return [];
  }
}

function findHashParam(hash: string, name: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw;
  const params = new URLSearchParams(query);
  const direct = params.get(name);
  if (direct) return direct;
  if (raw.startsWith(`${name}=`)) return new URLSearchParams(raw).get(name);
  return null;
}

function decodeBase64UrlJson(value: string): string {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  if (typeof atob === 'function') return decodeURIComponent(escape(atob(padded)));
  return Buffer.from(padded, 'base64').toString('utf8');
}
