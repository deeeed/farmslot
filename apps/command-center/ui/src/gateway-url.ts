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

function isLoopbackWebSocketHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

/**
 * From an HTTPS page the browser blocks insecure ws:// connections as mixed content,
 * except to loopback hosts (localhost/127.0.0.1), which are treated as potentially
 * trustworthy. A blocked candidate can never connect, so attempting it is dead noise
 * that only inflates the reconnect backoff.
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
  if (parsed.protocol !== 'ws:') return false;
  return !isLoopbackWebSocketHost(parsed.hostname);
}

/**
 * Drop gateway candidates the browser would refuse to connect to from the current page.
 * Returns the surviving candidates plus the ones skipped (for one-time logging). If every
 * candidate is blocked, the originals are kept so the UI still surfaces a real attempt
 * (and the doctor's guidance) instead of silently doing nothing.
 */
export function filterConnectableGatewayUrls(
  urls: string[],
  currentLocation: BrowserLocationLike,
): { urls: string[]; skipped: string[] } {
  const skipped: string[] = [];
  const connectable = urls.filter((url) => {
    if (isInsecureWebSocketBlocked(url, currentLocation)) {
      skipped.push(url);
      return false;
    }
    return true;
  });
  if (connectable.length === 0) return { urls, skipped: [] };
  return { urls: connectable, skipped };
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
