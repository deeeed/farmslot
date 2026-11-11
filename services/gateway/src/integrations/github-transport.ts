// github-transport.ts — one in-process HTTP client for GitHub REST and GraphQL.
// Endpoints follow gh's ghinstance rules (github.com, *.ghe.com tenancy, GitHub
// Enterprise Server). Tokens come from the gh keyring at most once a minute per
// host/account and are cached in memory; they are never logged, persisted, or used
// as cache keys.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitHubHttpRequest {
  method: string;
  url: string;
  token: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface GitHubHttpResponse {
  status: number;
  statusText: string;
  headers: Map<string, string>;
  body: string;
  url: string;
}

/** Aborts keep Node's AbortError shape so callers and the client skip failure caching. */
export class GitHubRequestAbortedError extends Error {
  readonly code = 'ABORT_ERR';
  constructor(cause: unknown) {
    super('The operation was aborted', { cause });
    this.name = 'AbortError';
  }
}

// ─── Endpoints ───

/**
 * FARMSLOT_GITHUB_API_URL routes every host's REST and GraphQL calls to one origin
 * (local fixture servers in tests, live scenarios and proof scripts).
 */
function overrideOrigin(): string | null {
  const origin = process.env.FARMSLOT_GITHUB_API_URL?.trim();
  return origin ? origin.replace(/\/+$/, '') : null;
}

function isTenancy(host: string): boolean {
  return host.toLowerCase().endsWith('.ghe.com');
}

function isEnterprise(host: string): boolean {
  const lower = host.toLowerCase();
  return lower !== 'github.com' && lower !== 'github.localhost' && !isTenancy(lower);
}

export function restPrefix(host: string): string {
  const origin = overrideOrigin();
  if (origin) return `${origin}/`;
  if (host.toLowerCase() === 'garage.github.com' || isEnterprise(host))
    return `https://${host}/api/v3/`;
  if (host.toLowerCase() === 'github.localhost') return `http://api.${host}/`;
  return `https://api.${host}/`;
}

export function graphqlEndpoint(host: string): string {
  const origin = overrideOrigin();
  if (origin) return `${origin}/graphql`;
  if (host.toLowerCase() === 'garage.github.com' || isEnterprise(host))
    return `https://${host}/api/graphql`;
  if (host.toLowerCase() === 'github.localhost') return `http://api.${host}/graphql`;
  return `https://api.${host}/graphql`;
}

/** gh's DefaultHost when no host flag or account is given. */
export function defaultGitHubHost(): string {
  return process.env.GH_HOST?.trim() || 'github.com';
}

// ─── Credentials ───

interface TokenEntry {
  promise: Promise<string>;
  token?: string;
  readAt: number;
}
const tokens = new Map<string, TokenEntry>();
/** `gh auth switch` or a refreshed token reaches the gateway within this window. */
const TOKEN_TTL_MS = 60_000;

function tokenKey(host: string, login?: string): string {
  return JSON.stringify([host.toLowerCase(), login?.toLowerCase() ?? null]);
}

/**
 * Token gh would use for this host (and named keyring account), cached for TOKEN_TTL_MS.
 * The environment mirrors the previous `gh` spawns: GH_TOKEN is ignored so the keyring
 * wins; a named account also ignores the other token variables.
 *
 * When `FARMSLOT_GITHUB_API_URL` is set the transport routes all requests to a fixture
 * server, so the keyring is never read. The optional `FARMSLOT_GITHUB_FIXTURE_TOKEN` is
 * returned verbatim (empty string when unset → no Authorization header sent).
 */
export function resolveGitHubToken(host: string, login?: string): Promise<string> {
  if (overrideOrigin())
    return Promise.resolve(process.env.FARMSLOT_GITHUB_FIXTURE_TOKEN?.trim() ?? '');

  const key = tokenKey(host, login);
  const existing = tokens.get(key);
  if (existing && Date.now() - existing.readAt < TOKEN_TTL_MS) return existing.promise;
  const entry: TokenEntry = { promise: readKeyringToken(host, login), readAt: Date.now() };
  tokens.set(key, entry);
  entry.promise.then(
    (token) => {
      entry.token = token;
    },
    () => {
      // A failed read is not cached so the next request retries the keyring. The
      // rejection itself reaches every caller through entry.promise.
      if (tokens.get(key) === entry) tokens.delete(key);
    },
  );
  return entry.promise;
}

async function readKeyringToken(host: string, login?: string): Promise<string> {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  if (login) {
    delete env.GITHUB_TOKEN;
    delete env.GH_ENTERPRISE_TOKEN;
    delete env.GITHUB_ENTERPRISE_TOKEN;
  }
  let token: string;
  try {
    const result = await execFileAsync(
      'gh',
      ['auth', 'token', '--hostname', host, ...(login ? ['--user', login] : [])],
      { env, timeout: 15_000, maxBuffer: 64 * 1024 },
    );
    token = result.stdout.trim();
  } catch {
    // Child errors can contain credential output. Report a fixed, actionable error instead.
    throw new Error(
      `GitHub account ${login ?? 'default'}@${host} is unavailable in the gateway keyring`,
    );
  }
  if (!token) throw new Error('GitHub account has no credential');
  return token;
}

/** A 401 means the keyring token changed: drop it so the next use re-reads the keyring. */
export function forgetGitHubToken(token: string): void {
  for (const [key, entry] of tokens) if (entry.token === token) tokens.delete(key);
}

export function resetGitHubTokensForTests(): void {
  tokens.clear();
}

/** Stable, non-reversible credential identity for cache keys. */
export function credentialFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ─── Requests ───

const API_VERSION = '2022-11-28';
const USER_AGENT = 'farmslot-gateway';

export async function githubHttp(request: GitHubHttpRequest): Promise<GitHubHttpResponse> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': API_VERSION,
    ...request.headers,
    // An empty token means fixture mode (FARMSLOT_GITHUB_API_URL set without a fixture token).
    // Omit the Authorization header entirely so the fixture server can respond freely.
    ...(request.token ? { Authorization: `token ${request.token}` } : {}),
  };
  let response: Response;
  let body: string;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers,
      body: request.body,
      signal: request.signal,
    });
    body = await response.text();
  } catch (error) {
    if (request.signal?.aborted) throw new GitHubRequestAbortedError(request.signal.reason);
    throw new Error(
      `error connecting to ${new URL(request.url).host}: ${(error as Error).message}`,
      { cause: error },
    );
  }
  const responseHeaders = new Map<string, string>();
  response.headers.forEach((value, name) => responseHeaders.set(name.toLowerCase(), value));
  return {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    body,
    url: request.url,
  };
}

export function isJsonContentType(headers: Map<string, string>): boolean {
  return /[/+]json($|;)/.test(headers.get('content-type') ?? '');
}
