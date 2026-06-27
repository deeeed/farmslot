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

export const GATEWAY_URL_STORAGE_KEY = 'farmslot.gateway.url';
export const GATEWAY_CANDIDATES_STORAGE_KEY = 'farmslot.gateway.candidates';
export const GATEWAY_TOKEN_STORAGE_KEY = 'farmslot.gateway.token';
export const GATEWAY_PASSWORD_STORAGE_KEY = 'farmslot.gateway.password';

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
): string[] {
  const trimmedUrl = configuredUrl?.trim();
  if (trimmedUrl) return [normalizeGatewayWebSocketUrl(trimmedUrl)];

  const hosted = parseHostedGatewayConnection(currentLocation.hash ?? '');
  if (hosted.urls.length > 0) return hosted.urls;

  const stored = parseStoredGatewayCandidates(storedCandidates);
  if (stored.length > 0) return stored;

  const protocol = currentLocation.protocol === 'https:' ? 'wss:' : 'ws:';
  return [`${protocol}//${currentLocation.host}/ws`];
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

function normalizePayloadUrls(payload: HostedGatewayPayload): string[] {
  const raw: string[] = [];
  if (payload.gatewayUrl) raw.push(payload.gatewayUrl);
  if (payload.url) raw.push(payload.url);
  for (const entry of payload.gateways ?? []) {
    raw.push(typeof entry === 'string' ? entry : entry.url);
  }
  return [...new Set(raw.map((url) => normalizeGatewayWebSocketUrl(url)))];
}

function parseStoredGatewayCandidates(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
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
