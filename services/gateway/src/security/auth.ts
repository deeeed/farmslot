import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import os from 'node:os';

import type {
  AuthenticationRef,
  GatewayAuthClientKind,
  GatewayAuthConnectParams,
  Principal,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

import { authorizeGatewayHttp } from './authorization.js';
import { CredentialStoreRuntime } from './credential-store.js';
import { CredentialStoreWriter } from './credential-store-writer.js';
import { reconcileEnvironmentCredential } from './env-credential-migration.js';
import { PrincipalResolver } from './principal-resolver.js';

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
  authentication?: AuthenticationRef;
}

export interface GatewayAuthRuntime {
  auth: ResolvedGatewayAuth;
  limiter: GatewayAuthRateLimiter;
  store: CredentialStoreRuntime;
  writer: CredentialStoreWriter;
  resolver: PrincipalResolver;
}

export interface GatewayAuthResult {
  ok: boolean;
  mode?: GatewayAuthMode;
  reason?: string;
  rateLimited?: boolean;
  retryAfterMs?: number;
  authentication?: AuthenticationRef;
  principal?: Principal;
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
const HTTP_PASSWORD_COOKIE = 'farmslot_gateway_password';
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
  const auth = resolveGatewayAuth(env);
  const store = new CredentialStoreRuntime(env);
  const resolver = new PrincipalResolver(store, {
    bindIsLoopbackOnly: isLoopbackHost(env.GATEWAY_HOST?.trim() || '127.0.0.1'),
    trustProxyHeaders: shouldTrustProxyHeaders(env),
    machine: os.hostname().replace(/\.local$/u, ''),
  });
  return {
    auth,
    limiter: new GatewayAuthRateLimiter(),
    store,
    writer: new CredentialStoreWriter(store),
    resolver,
  };
}

export function initializeGatewayIdentity(
  runtime: GatewayAuthRuntime,
  params: { host?: string; machine?: string; log?: (message: string) => void } = {},
): void {
  runtime.resolver.setFacts({
    bindIsLoopbackOnly: isLoopbackHost(params.host?.trim() || '127.0.0.1'),
    trustProxyHeaders: shouldTrustProxyHeaders(runtime.store.env),
    machine: params.machine ?? os.hostname().replace(/\.local$/u, ''),
  });
  reconcileEnvironmentCredential({
    auth: runtime.auth,
    writer: runtime.writer,
    resolver: runtime.resolver,
    log: params.log,
  });
}

export function startCredentialFreshnessPolling(runtime: GatewayAuthRuntime): () => void {
  const timer = setInterval(() => runtime.store.ensureFresh(), 2_000);
  timer.unref();
  return () => clearInterval(timer);
}

export function latchActivationForExposure(
  runtime: GatewayAuthRuntime,
  host: string | undefined,
): boolean {
  const nonLoopbackBind = !isLoopbackHost(host?.trim() || '0.0.0.0');
  if (!nonLoopbackBind && !shouldTrustProxyHeaders(runtime.store.env)) return false;
  return runtime.writer.latchActivation();
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
  const rateLimitApplies =
    shouldTrustProxyHeaders(params.runtime.store.env) || !isLoopbackClientIp(params.clientIp);
  if (rateLimitApplies) {
    const rateLimited = limiter.check(params.clientIp);
    if (rateLimited) return rateLimited;
  }

  if (
    params.runtime.resolver.isSoloMode() &&
    !params.connectParams.token &&
    !params.connectParams.password
  ) {
    limiter.reset(params.clientIp);
    const resolution = params.runtime.resolver.resolveSessionPrincipal({
      authenticated: true,
      clientKind: params.connectParams.clientKind,
    });
    return resolution.ok
      ? { ok: true, mode: 'none', principal: resolution.principal }
      : { ok: false, reason: resolution.reason };
  }

  const token = params.connectParams.token;
  const password = params.connectParams.password;
  const transport = token ? 'token' : password ? 'password' : undefined;
  const presented = token ?? password;
  if (!transport || !presented) {
    return { ok: false, reason: `${auth.mode === 'password' ? 'password' : 'token'}_missing` };
  }
  const resolution = params.runtime.resolver.resolveSecret(presented, transport);
  if (!resolution.ok) {
    if (rateLimitApplies) limiter.recordFailure(params.clientIp);
    return { ok: false, reason: 'credential_mismatch' };
  }
  limiter.reset(params.clientIp);
  return {
    ok: true,
    mode: transport,
    authentication: resolution.authentication,
    principal: resolution.principal,
  };
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
  if (!session.authenticated) throw new GatewayAuthError('Authentication required');
  const resolution = runtime.resolver.resolveSessionPrincipal(session);
  if (!resolution.ok) throw new GatewayAuthError('Authentication required');
}

export function requireNodeSession(runtime: GatewayAuthRuntime, session: GatewayAuthSession): void {
  requireAuthenticatedSession(runtime, session);
  const resolution = runtime.resolver.resolveSessionPrincipal(session);
  if (!resolution.ok || resolution.principal.subject.type !== 'node') {
    throw new GatewayAuthError('Node client authentication required', 'AUTH_FORBIDDEN');
  }
}

export function authorizeHttpRequest(params: {
  runtime: GatewayAuthRuntime;
  req: IncomingMessage;
  res: ServerResponse;
}): boolean {
  if (params.runtime.resolver.isSoloMode()) return true;
  const credential = getHttpCredential(params.req);
  const result = authenticateGatewayClient({
    runtime: params.runtime,
    connectParams: {
      clientKind: 'companion',
      ...(credential?.transport === 'token' ? { token: credential.value } : {}),
      ...(credential?.transport === 'password' ? { password: credential.value } : {}),
    },
    clientIp: resolveRequestIp(params.req, params.runtime.store.env),
  });
  if (result.ok) {
    try {
      authorizeGatewayHttp(params.runtime, {
        authenticated: true,
        clientKind: 'companion',
        authentication: result.authentication,
      });
      return true;
    } catch (error) {
      if (!(error instanceof GatewayMethodError)) throw error;
      const denial = error;
      params.res.writeHead(403, { 'Content-Type': 'application/json' });
      params.res.end(
        JSON.stringify({
          error: 'Forbidden',
          message: denial.message,
          ...(denial.userAction ? { userAction: denial.userAction } : {}),
        }),
      );
      return false;
    }
  }
  sendAuthFailure(params.res, result);
  return false;
}

export function resolveRequestIp(
  req: IncomingMessage,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const socketAddress = req.socket.remoteAddress || 'unknown';
  if (!shouldTrustProxyHeaders(env)) return socketAddress;

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

export function shouldTrustProxyHeaders(env: NodeJS.ProcessEnv = process.env): boolean {
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

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isGatewayAuthMode(value: string): value is GatewayAuthMode {
  return value === 'none' || value === 'token' || value === 'password';
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost') return true;
  if (normalized === '::1' || normalized === '[::1]') return true;
  if (net.isIP(normalized) === 4) return normalized.startsWith('127.');
  return false;
}

export function getHttpCredential(
  req: IncomingMessage,
): { value: string; transport: 'token' | 'password' } | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    if (auth.startsWith(AUTH_HEADER_PREFIX)) {
      const value = nonEmpty(auth.slice(AUTH_HEADER_PREFIX.length));
      return value ? { value, transport: 'token' } : undefined;
    }
    if (auth.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const value = nonEmpty(separator >= 0 ? decoded.slice(separator + 1) : decoded);
      return value ? { value, transport: 'password' } : undefined;
    }
  }
  const queryToken = getQueryCredential(req.url, 'token');
  const queryPassword = getQueryCredential(req.url, 'password');
  if (queryToken && queryPassword) return undefined;
  if (queryToken) return { value: queryToken, transport: 'token' };
  if (queryPassword) return { value: queryPassword, transport: 'password' };
  const cookieToken = getCookieValue(req.headers.cookie, HTTP_AUTH_COOKIE);
  const cookiePassword = getCookieValue(req.headers.cookie, HTTP_PASSWORD_COOKIE);
  if (cookieToken && cookiePassword) return undefined;
  if (cookieToken) return { value: cookieToken, transport: 'token' };
  return cookiePassword ? { value: cookiePassword, transport: 'password' } : undefined;
}

// Query-string credentials exist only for header-incapable resources. The
// parameter name preserves the transport distinction: `token` can resolve issued
// credentials, while `password` is legacy environment-password compatibility.
// Query secrets are intrinsically more exposed than headers, so the gateway must
// never log raw req.url and fetch-capable clients keep credentials in headers.
function getQueryCredential(
  url: string | undefined,
  name: 'token' | 'password',
): string | undefined {
  if (!url) return undefined;
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return undefined;
  const hashStart = url.indexOf('#', queryStart);
  const query = url.slice(queryStart + 1, hashStart >= 0 ? hashStart : undefined);
  const params = new URLSearchParams(query);
  return nonEmpty(params.get(name) ?? undefined);
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
