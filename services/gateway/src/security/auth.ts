import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';

import type { GatewayAuthClientKind, GatewayAuthConnectParams } from '@farmslot/protocol';

export type GatewayAuthMode = 'none' | 'token' | 'password';

export interface ResolvedGatewayAuth {
  mode: GatewayAuthMode;
  token?: string;
  password?: string;
  source: 'env' | 'explicit-none' | 'default-none';
}

export interface GatewayAuthSession {
  authenticated: boolean;
  clientKind?: GatewayAuthClientKind;
  authMode?: GatewayAuthMode;
  authenticatedAt?: number;
}

export interface GatewayAuthRuntime {
  auth: ResolvedGatewayAuth;
  limiter: GatewayAuthRateLimiter;
}

export interface GatewayAuthResult {
  ok: boolean;
  mode?: GatewayAuthMode;
  reason?: string;
  rateLimited?: boolean;
  retryAfterMs?: number;
}

export class GatewayAuthError extends Error {
  constructor(
    message: string,
    readonly code = 'AUTH_REQUIRED',
  ) {
    super(message);
    this.name = 'GatewayAuthError';
  }
}

const DEFAULT_RATE_LIMIT_MAX = 8;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const AUTH_HEADER_PREFIX = 'Bearer ';
const HTTP_AUTH_COOKIE = 'farmslot_gateway_credential';
const TRUST_PROXY_HEADERS_ENV = 'FARMSLOT_GATEWAY_TRUST_PROXY_HEADERS';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export class GatewayAuthRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(
    private readonly maxAttempts = DEFAULT_RATE_LIMIT_MAX,
    private readonly windowMs = DEFAULT_RATE_LIMIT_WINDOW_MS,
  ) {}

  check(key: string): GatewayAuthResult | null {
    const bucket = this.buckets.get(key);
    if (!bucket) return null;
    const now = Date.now();
    if (bucket.resetAt <= now) {
      this.buckets.delete(key);
      return null;
    }
    if (bucket.count < this.maxAttempts) return null;
    return {
      ok: false,
      reason: 'rate_limited',
      rateLimited: true,
      retryAfterMs: bucket.resetAt - now,
    };
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    existing.count += 1;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}

export function resolveGatewayAuth(env: NodeJS.ProcessEnv = process.env): ResolvedGatewayAuth {
  const rawMode = env.FARMSLOT_GATEWAY_AUTH_MODE?.trim().toLowerCase();
  const token = nonEmpty(env.FARMSLOT_GATEWAY_TOKEN);
  const password = nonEmpty(env.FARMSLOT_GATEWAY_PASSWORD);

  if (rawMode) {
    if (!isGatewayAuthMode(rawMode)) {
      throw new Error(
        `Invalid FARMSLOT_GATEWAY_AUTH_MODE=${rawMode}; expected none, token, or password`,
      );
    }
    return requireCredentialForMode({ mode: rawMode, token, password, source: 'env' });
  }

  if (password) return { mode: 'password', password, token, source: 'env' };
  if (token) return { mode: 'token', token, password, source: 'env' };
  return { mode: 'none', source: 'default-none' };
}

export function createGatewayAuthRuntime(env: NodeJS.ProcessEnv = process.env): GatewayAuthRuntime {
  return {
    auth: resolveGatewayAuth(env),
    limiter: new GatewayAuthRateLimiter(),
  };
}

export function assertGatewayBindAllowed(params: {
  auth: ResolvedGatewayAuth;
  host?: string;
  port: number;
}): void {
  if (params.auth.mode !== 'none') return;
  const host = params.host?.trim();
  if (host && isLoopbackHost(host)) return;
  if (host && !isLoopbackHost(host)) {
    throw new Error(
      `Refusing to bind unauthenticated gateway to ${host}:${params.port}; set FARMSLOT_GATEWAY_TOKEN or FARMSLOT_GATEWAY_PASSWORD, or explicitly bind to 127.0.0.1 for local-only dev`,
    );
  }
  if (process.env.FARMSLOT_GATEWAY_ALLOW_UNAUTHENTICATED_ANY_HOST === '1') return;
  throw new Error(
    `Refusing to bind unauthenticated gateway to all interfaces on port ${params.port}; set GATEWAY_HOST=127.0.0.1 for local-only dev, set FARMSLOT_GATEWAY_TOKEN/PASSWORD for remote access, or set FARMSLOT_GATEWAY_ALLOW_UNAUTHENTICATED_ANY_HOST=1 for explicit insecure dev`,
  );
}

export function authenticateGatewayClient(params: {
  runtime: GatewayAuthRuntime;
  connectParams: GatewayAuthConnectParams;
  clientIp: string;
}): GatewayAuthResult {
  const { auth, limiter } = params.runtime;
  // A loopback client (the local browser or hosted Command Center connecting to
  // ws://localhost) already implies same-machine trust — a local process can read the
  // token file anyway. Rate-limiting it just locks out a *valid* token for the window
  // after a few stale-token retries share the 127.0.0.1 bucket, so exempt it.
  //
  // Only exempt when we are NOT trusting proxy headers: without proxy trust, clientIp
  // is the real socket peer (unspoofable), so a loopback IP is a genuine local client.
  // With proxy trust on there is a reverse proxy in front, clientIp comes from
  // X-Forwarded-For and a remote client could forge 127.0.0.1 — never exempt then, so
  // brute-force protection stays on for remote callers.
  const rateLimitApplies = shouldTrustProxyHeaders() || !isLoopbackClientIp(params.clientIp);
  if (rateLimitApplies) {
    const rateLimited = limiter.check(params.clientIp);
    if (rateLimited) return rateLimited;
  }

  if (auth.mode === 'none') {
    limiter.reset(params.clientIp);
    return { ok: true, mode: 'none' };
  }

  if (auth.mode === 'token') {
    if (!auth.token) return { ok: false, reason: 'token_missing_config' };
    if (!params.connectParams.token) return { ok: false, reason: 'token_missing' };
    if (!safeEqualSecret(params.connectParams.token, auth.token)) {
      if (rateLimitApplies) limiter.recordFailure(params.clientIp);
      return { ok: false, reason: 'token_mismatch' };
    }
    limiter.reset(params.clientIp);
    return { ok: true, mode: 'token' };
  }

  if (!auth.password) return { ok: false, reason: 'password_missing_config' };
  if (!params.connectParams.password) return { ok: false, reason: 'password_missing' };
  if (!safeEqualSecret(params.connectParams.password, auth.password)) {
    if (rateLimitApplies) limiter.recordFailure(params.clientIp);
    return { ok: false, reason: 'password_mismatch' };
  }
  limiter.reset(params.clientIp);
  return { ok: true, mode: 'password' };
}

// A loopback client IP, tolerant of the IPv4-mapped IPv6 form Node reports
// (e.g. ::ffff:127.0.0.1) in addition to 127.x / ::1 / localhost.
function isLoopbackClientIp(ip: string): boolean {
  return isLoopbackHost(
    ip
      .trim()
      .toLowerCase()
      .replace(/^::ffff:/, ''),
  );
}

export function requireAuthenticatedSession(
  runtime: GatewayAuthRuntime,
  session: GatewayAuthSession,
): void {
  if (runtime.auth.mode === 'none') return;
  if (!session.authenticated) throw new GatewayAuthError('Authentication required');
}

export function requireNodeSession(runtime: GatewayAuthRuntime, session: GatewayAuthSession): void {
  requireAuthenticatedSession(runtime, session);
  if (runtime.auth.mode !== 'none' && session.clientKind !== 'node') {
    throw new GatewayAuthError('Node client authentication required', 'AUTH_FORBIDDEN');
  }
}

export function authorizeHttpRequest(params: {
  runtime: GatewayAuthRuntime;
  req: IncomingMessage;
  res: ServerResponse;
}): boolean {
  if (params.runtime.auth.mode === 'none') return true;
  const credential = getHttpCredential(params.req);
  const result = authenticateGatewayClient({
    runtime: params.runtime,
    connectParams: {
      clientKind: 'companion',
      token: credential,
      password: credential,
    },
    clientIp: resolveRequestIp(params.req),
  });
  if (result.ok) return true;
  sendAuthFailure(params.res, result);
  return false;
}

export function resolveRequestIp(req: IncomingMessage): string {
  const socketAddress = req.socket.remoteAddress || 'unknown';
  if (!shouldTrustProxyHeaders()) return socketAddress;

  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0]?.trim() || socketAddress;
  }
  return socketAddress;
}

export function sanitizeAuthFailureReason(reason: string | undefined): string {
  if (!reason) return 'unauthorized';
  if (reason.includes('mismatch')) return 'credential_mismatch';
  if (reason.includes('missing')) return reason;
  return reason;
}

function shouldTrustProxyHeaders(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[TRUST_PROXY_HEADERS_ENV]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function requireCredentialForMode(auth: ResolvedGatewayAuth): ResolvedGatewayAuth {
  if (auth.mode === 'none') return { ...auth, source: 'explicit-none' };
  if (auth.mode === 'token' && !auth.token) {
    throw new Error('FARMSLOT_GATEWAY_AUTH_MODE=token requires FARMSLOT_GATEWAY_TOKEN');
  }
  if (auth.mode === 'password' && !auth.password) {
    throw new Error('FARMSLOT_GATEWAY_AUTH_MODE=password requires FARMSLOT_GATEWAY_PASSWORD');
  }
  return auth;
}

function safeEqualSecret(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    const padded = Buffer.alloc(expectedBuffer.length);
    actualBuffer.copy(padded, 0, 0, Math.min(actualBuffer.length, expectedBuffer.length));
    timingSafeEqual(padded, expectedBuffer);
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isGatewayAuthMode(value: string): value is GatewayAuthMode {
  return value === 'none' || value === 'token' || value === 'password';
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost') return true;
  if (normalized === '::1' || normalized === '[::1]') return true;
  if (net.isIP(normalized) === 4) return normalized.startsWith('127.');
  return false;
}

function getHttpCredential(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    if (auth.startsWith(AUTH_HEADER_PREFIX)) {
      return nonEmpty(auth.slice(AUTH_HEADER_PREFIX.length));
    }
    if (auth.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      return nonEmpty(separator >= 0 ? decoded.slice(separator + 1) : decoded);
    }
  }
  const queryCredential = getQueryCredential(req.url);
  if (queryCredential) return queryCredential;
  return getCookieValue(req.headers.cookie, HTTP_AUTH_COOKIE);
}

// Query-string credentials exist only for header-incapable clients (React Native
// <Image>/Source, which cannot send an Authorization header). They are accepted
// last (after header and before cookie) and compared with the same constant-time
// check + rate limiter as header auth. Query tokens are intrinsically more
// exposed than headers (browser history, Referer, intermediary access logs), so
// the gateway must never log raw req.url, and the companion only appends a query
// token on Image/Source URLs — fetch() calls stay header-only (gatewayFetch).
function getQueryCredential(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return undefined;
  const hashStart = url.indexOf('#', queryStart);
  const query = url.slice(queryStart + 1, hashStart >= 0 ? hashStart : undefined);
  const params = new URLSearchParams(query);
  return nonEmpty(params.get('token') ?? undefined);
}

function getCookieValue(
  cookieHeader: string | string[] | undefined,
  name: string,
): string | undefined {
  const rawCookieHeader = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader;
  if (!rawCookieHeader) return undefined;
  const encodedName = encodeURIComponent(name);
  for (const part of rawCookieHeader.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const cookieName = trimmed.slice(0, separator);
    if (cookieName !== name && cookieName !== encodedName) continue;
    return nonEmpty(decodeCookieValue(trimmed.slice(separator + 1)));
  }
  return undefined;
}

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) {
      return value;
    }
    throw error;
  }
}

function sendAuthFailure(res: ServerResponse, result: GatewayAuthResult): void {
  const status = result.rateLimited ? 429 : 401;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer realm="farmslot-gateway"',
    ...(result.retryAfterMs
      ? { 'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)) }
      : {}),
  });
  res.end(
    JSON.stringify({
      error: result.rateLimited ? 'Rate limited' : 'Authentication required',
      reason: sanitizeAuthFailureReason(result.reason),
    }),
  );
}
