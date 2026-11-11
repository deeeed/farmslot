// github-gh-command.ts — runs the `gh` argument lists gateway callers pass to ghRequest,
// in-process over HTTP. Semantics mirror gh 2.98: `gh api` field typing, method choice,
// pagination and output joining (pkg/cmd/api), and the `pr`/`repo` subcommands' GraphQL
// fields, export shapes and check buckets (pkg/cmd/pr, api/export_pr.go). Anything outside
// the supported grammar throws instead of guessing.
import { readFile } from 'node:fs/promises';

import type { CommandOutput } from '@farmslot/protocol';

import {
  encodeGoJson,
  GO_EXPORT_ENCODING,
  GO_MARSHAL_ENCODING,
  goStruct,
  type JqValue,
  runGitHubJq,
} from './github-jq.js';
import {
  credentialFingerprint,
  defaultGitHubHost,
  forgetGitHubToken,
  githubHttp,
  type GitHubHttpResponse,
  graphqlEndpoint,
  isJsonContentType,
  resolveGitHubToken,
  restPrefix,
} from './github-transport.js';

export interface GhAccount {
  host: string;
  token: string;
  scope: string;
}

export interface GhCommandContext {
  signal?: AbortSignal;
  account?: GhAccount;
}

export interface GhCommandResult extends CommandOutput {
  /** Single-request `gh api` only: the response status `--include` used to expose. */
  status?: number;
  /** Single-request `gh api` only: gh would exit non-zero (HTTP > 299 or GraphQL errors). */
  failed?: boolean;
  /** Single-request `gh api` only: the unfiltered response body. */
  rawBody?: string;
  /** Headers of the last response, for quota observation on every path. */
  headers?: Map<string, string>;
  /** GraphQL points spent, when the responses reported them; pages count at least one each. */
  graphqlCost?: number;
}

type JsonObject = { [key: string]: JqValue };

const GH_DEFAULT_ACCEPT =
  'application/vnd.github.merge-info-preview+json, application/vnd.github.nebula-preview';
const ZERO_TIME = '0001-01-01T00:00:00Z';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

class GhFailure extends Error {}

export async function executeGhCommand(
  args: string[],
  context: GhCommandContext = {},
): Promise<GhCommandResult> {
  try {
    if (args[0] === 'api') return await runApi(args.slice(1), context);
    if (args[0] === 'pr') return await runPr(args[1], args.slice(2), context);
    if (args[0] === 'repo' && args[1] === 'view') return await runRepoView(args.slice(2), context);
    throw new GhFailure(`unsupported gh command: ${args.slice(0, 2).join(' ')}`);
  } catch (error) {
    if (error instanceof GhFailure)
      throw new Error(`gh ${args.join(' ')} failed: ${error.message}`);
    throw error;
  }
}

// ─── Flag parsing ───

interface FlagSpec {
  values: Record<string, string>;
  booleans: Record<string, string>;
}

interface ParsedFlags {
  values: Map<string, string[]>;
  booleans: Set<string>;
  positionals: string[];
}

function parseFlags(argv: string[], spec: FlagSpec): ParsedFlags {
  const parsed: ParsedFlags = { values: new Map(), booleans: new Set(), positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('-') || raw === '-') {
      parsed.positionals.push(raw);
      continue;
    }
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const name = eq > 0 ? raw.slice(0, eq) : raw;
    const valueName = spec.values[name];
    const booleanName = spec.booleans[name];
    if (valueName) {
      const value = eq > 0 ? raw.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new GhFailure(`flag needs an argument: ${name}`);
      parsed.values.set(valueName, [...(parsed.values.get(valueName) ?? []), value]);
    } else if (booleanName && eq < 0) {
      parsed.booleans.add(booleanName);
    } else {
      throw new GhFailure(`unsupported flag: ${name}`);
    }
  }
  return parsed;
}

function lastValue(flags: ParsedFlags, name: string): string | undefined {
  return flags.values.get(name)?.at(-1);
}

// ─── HTTP with credentials and conditional GETs ───

export interface ConditionalEntry {
  etag: string;
  body: string;
  contentType: string;
  link: string;
  bytes: number;
}

/** Least-recently-used ETag cache, bounded by entry count and approximate bytes. */
export class ConditionalCache {
  private readonly entries = new Map<string, ConditionalEntry>();
  private bytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {}

  get(key: string): ConditionalEntry | undefined {
    return this.entries.get(key);
  }

  /** Insert or refresh; a single body larger than a quarter of the budget is not cached. */
  set(key: string, entry: ConditionalEntry): void {
    this.delete(key);
    if (entry.bytes > this.maxBytes / 4) return;
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  delete(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    this.entries.delete(key);
    this.bytes -= existing.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

const conditionalCache = new ConditionalCache(512, 32 * 1024 * 1024);

export function resetGitHubConditionalCacheForTests(): void {
  conditionalCache.clear();
}

interface SendRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * One HTTP exchange. GETs revalidate a cached ETag, so unchanged data costs a 304 that
 * GitHub does not count against the rate limit; the caller still sees the full body.
 * An ambient keyring token that GitHub rejects is re-read once and the request retried.
 */
async function send(
  host: string,
  request: SendRequest,
  context: GhCommandContext,
): Promise<GitHubHttpResponse> {
  let token = context.account?.token ?? (await resolveGitHubToken(host));
  for (let attempt = 0; ; attempt++) {
    const key =
      request.method === 'GET'
        ? JSON.stringify([
            host.toLowerCase(),
            credentialFingerprint(token),
            request.url,
            request.headers.Accept ?? '',
          ])
        : undefined;
    const cached = key ? conditionalCache.get(key) : undefined;
    const response = await githubHttp({
      ...request,
      headers: cached ? { ...request.headers, 'If-None-Match': cached.etag } : request.headers,
      token,
      signal: context.signal,
    });
    if (response.status === 401) {
      forgetGitHubToken(token);
      if (!context.account && attempt === 0) {
        const fresh = await resolveGitHubToken(host);
        if (fresh !== token) {
          token = fresh;
          continue;
        }
      }
      return response;
    }
    if (key && cached && response.status === 304) {
      // Refresh recency; the entry is still valid.
      conditionalCache.set(key, cached);
      const headers = new Map(response.headers);
      headers.set('content-type', cached.contentType);
      if (cached.link) headers.set('link', cached.link);
      else headers.delete('link');
      return { ...response, status: 200, statusText: 'OK', headers, body: cached.body };
    }
    const etag = response.headers.get('etag');
    if (key && response.status === 200 && etag) {
      conditionalCache.set(key, {
        etag,
        body: response.body,
        contentType: response.headers.get('content-type') ?? '',
        link: response.headers.get('link') ?? '',
        bytes: response.body.length * 2,
      });
    }
    return response;
  }
}

// ─── gh api ───

const API_FLAGS: FlagSpec = {
  values: {
    '--hostname': 'hostname',
    '-X': 'method',
    '--method': 'method',
    '-f': 'raw-field',
    '--raw-field': 'raw-field',
    '-F': 'field',
    '--field': 'field',
    '-H': 'header',
    '--header': 'header',
    '-q': 'jq',
    '--jq': 'jq',
    '--input': 'input',
  },
  booleans: { '--paginate': 'paginate', '--slurp': 'slurp', '--silent': 'silent' },
};

type Params = { [key: string]: JqValue };

async function runApi(argv: string[], context: GhCommandContext): Promise<GhCommandResult> {
  const flags = parseFlags(argv, API_FLAGS);
  if (flags.positionals.length !== 1) throw new GhFailure('gh api needs exactly one endpoint');
  const endpoint = flags.positionals[0];
  const paginate = flags.booleans.has('paginate');
  const slurp = flags.booleans.has('slurp');
  const jq = lastValue(flags, 'jq');
  if (slurp && (!paginate || jq)) throw new GhFailure('--slurp needs --paginate and no --jq');
  const isGraphQL = endpoint === 'graphql';
  const host = lastValue(flags, 'hostname') ?? context.account?.host ?? defaultGitHubHost();
  const params = await parseFields(
    flags.values.get('raw-field') ?? [],
    flags.values.get('field') ?? [],
  );
  const inputFile = lastValue(flags, 'input');
  const methodFlag = lastValue(flags, 'method');
  const method = (
    methodFlag ?? (Object.keys(params).length > 0 || inputFile ? 'POST' : 'GET')
  ).toUpperCase();

  let path = endpoint;
  if (paginate && !isGraphQL) path = addPerPage(path, 100, params);
  const headers: Record<string, string> = {};
  for (const header of flags.values.get('header') ?? []) {
    const colon = header.indexOf(':');
    if (colon < 0) throw new GhFailure(`header "${header}" requires a value separated by ':'`);
    headers[canonicalHeader(header.slice(0, colon))] = header.slice(colon + 1).trim();
  }

  let url = path.includes('://')
    ? path
    : isGraphQL
      ? graphqlEndpoint(host)
      : restPrefix(host) + path.replace(/^\//, '');
  let body: string | undefined;
  if (inputFile) {
    url = addQuery(url, params);
    body = await readUserFile(inputFile);
  } else if (Object.keys(params).length > 0) {
    if (method === 'GET') {
      url = addQuery(url, params);
    } else {
      body = encodeGoJson(isGraphQL ? groupGraphQLVariables(params) : params, GO_MARSHAL_ENCODING);
    }
  }
  // go-gh sends a JSON content type on every request, --input bodies included.
  headers['Content-Type'] ??= JSON_CONTENT_TYPE;
  headers.Accept ??= '*/*';

  const output: string[] = [];
  let graphqlCost = 0;
  let lastHeaders: Map<string, string> | undefined;
  let pageCount = 0;
  for (;;) {
    const response = await send(host, { method, url, headers, body }, context);
    lastHeaders = response.headers;
    const next = isGraphQL ? undefined : findNextPage(response.headers.get('link'));
    const isLastPage = !paginate || (!isGraphQL && !next);
    const page = processPage(response, {
      isGraphQL,
      paginate,
      slurp,
      jq,
      isFirstPage: pageCount === 0,
      isLastPage,
      method,
    });
    pageCount++;
    if (isGraphQL) graphqlCost += graphqlCostOf(response.body) || 1;
    if (!paginate) {
      return {
        stdout: page.failed || flags.booleans.has('silent') ? '' : page.output,
        stderr: page.serverError ? `gh: ${page.serverError}\n` : '',
        status: response.status,
        failed: page.failed,
        rawBody: response.body,
        headers: response.headers,
        ...(isGraphQL ? { graphqlCost } : {}),
      };
    }
    if (page.failed) throw new GhFailure(`gh: ${page.serverError}`);
    output.push(page.output);
    if (isGraphQL) {
      const cursor = page.endCursor;
      if (!cursor) break;
      params.endCursor = cursor;
      body = encodeGoJson(groupGraphQLVariables(params), GO_MARSHAL_ENCODING);
    } else {
      if (!next) break;
      url = next;
      body = undefined;
    }
  }
  const joined = slurp ? `[${output.join(',')}]` : output.join('');
  return {
    stdout: flags.booleans.has('silent') ? '' : joined,
    stderr: '',
    headers: lastHeaders,
    ...(isGraphQL ? { graphqlCost } : {}),
  };
}

interface PageOptions {
  isGraphQL: boolean;
  paginate: boolean;
  slurp: boolean;
  jq?: string;
  isFirstPage: boolean;
  isLastPage: boolean;
  method: string;
}

interface PageResult {
  output: string;
  failed: boolean;
  serverError: string;
  endCursor: string;
}

/** gh processResponse for one page. */
function processPage(response: GitHubHttpResponse, options: PageOptions): PageResult {
  const result: PageResult = { output: '', failed: false, serverError: '', endCursor: '' };
  if (response.status === 204) return result;
  const isJson = isJsonContentType(response.headers);
  if (isJson && (options.isGraphQL || response.status >= 400) && options.method !== 'HEAD') {
    result.serverError = parseErrorResponse(response.body, response.status);
  }
  const graphQLPaginate =
    isJson && response.status === 200 && options.paginate && options.isGraphQL;
  if (options.jq && !result.serverError) {
    result.output = runGitHubJq(options.jq, parseJson(response.body));
  } else if (isJson && options.paginate && !options.slurp && !graphQLPaginate) {
    result.output = mergePageArray(response.body, options.isFirstPage, options.isLastPage);
  } else {
    result.output = response.body;
  }
  if (!result.serverError && response.status > 299) result.serverError = `HTTP ${response.status}`;
  if (result.serverError) {
    result.failed = true;
    return result;
  }
  if (graphQLPaginate) result.endCursor = findEndCursor(parseJson(response.body));
  return result;
}

function parseJson(text: string): JqValue {
  try {
    return JSON.parse(text) as JqValue;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new GhFailure(`invalid JSON response: ${error.message}`);
  }
}

function graphqlCostOf(body: string): number {
  if (!body.trimStart().startsWith('{')) return 0;
  try {
    const cost = (JSON.parse(body) as { data?: { rateLimit?: { cost?: unknown } } }).data?.rateLimit
      ?.cost;
    return typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : 0;
  } catch (error) {
    // Non-JSON bodies carry no cost; the failure itself is reported by processPage.
    if (!(error instanceof SyntaxError)) throw error;
    return 0;
  }
}

function canonicalHeader(name: string): string {
  return name
    .trim()
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('-');
}

async function readUserFile(path: string): Promise<string> {
  if (path === '-') throw new GhFailure('reading from stdin is not supported');
  return readFile(path, 'utf8');
}

/** gh fields.go: raw fields first, then typed (magic) fields; `key[]` and `key[sub]` nest. */
async function parseFields(rawFields: string[], magicFields: string[]): Promise<Params> {
  const params: Params = {};
  const parseField = async (field: string, magic: boolean) => {
    const keystack: string[] = [];
    let keyStartAt = 0;
    let valueIndex = 0;
    for (let i = 0; i < field.length; i++) {
      const ch = field[i];
      if (ch === '[') {
        if (keyStartAt === 0) keystack.push(field.slice(0, i));
        keyStartAt = i + 1;
      } else if (ch === ']') {
        keystack.push(field.slice(keyStartAt, i));
      } else if (ch === '=') {
        if (keyStartAt === 0) keystack.push(field.slice(0, i));
        valueIndex = i + 1;
        break;
      }
    }
    if (keystack.length === 0) throw new GhFailure(`invalid key: "${field}"`);
    let value: JqValue = null;
    if (valueIndex === 0) {
      if (keystack.at(-1) !== '')
        throw new GhFailure(`field "${field}" requires a value separated by an '=' sign`);
    } else {
      value = field.slice(valueIndex);
      if (magic) value = await magicFieldValue(value);
    }
    let dest: Params = params;
    let isArray = false;
    let subkey = '';
    for (const key of keystack) {
      if (key === '') {
        isArray = true;
        continue;
      }
      if (subkey !== '') {
        dest = isArray ? nestInArray(dest, subkey, key) : nestInObject(dest, subkey);
        isArray = false;
      }
      subkey = key;
    }
    if (isArray) {
      const existing = dest[subkey];
      if (valueIndex === 0) dest[subkey] = [];
      else if (existing === undefined) dest[subkey] = [value];
      else if (Array.isArray(existing)) existing.push(value);
      else throw new GhFailure(`expected array type under "${subkey}"`);
    } else {
      if (subkey in dest)
        throw new GhFailure(`unexpected override existing field under "${subkey}"`);
      dest[subkey] = value;
    }
  };
  for (const field of rawFields) await parseField(field, false);
  for (const field of magicFields) await parseField(field, true);
  return params;
}

function nestInObject(dest: Params, key: string): Params {
  const existing = dest[key];
  if (existing === undefined) {
    const created: Params = {};
    dest[key] = created;
    return created;
  }
  if (existing !== null && typeof existing === 'object' && !Array.isArray(existing))
    return existing;
  throw new GhFailure(`expected map type under "${key}"`);
}

function nestInArray(dest: Params, prevKey: string, newKey: string): Params {
  const existing = dest[prevKey];
  if (existing === undefined) {
    const created: Params = {};
    dest[prevKey] = [created];
    return created;
  }
  if (!Array.isArray(existing)) throw new GhFailure(`expected array type under "${prevKey}"`);
  const last = existing.at(-1);
  if (last !== null && typeof last === 'object' && !Array.isArray(last)) {
    if (!(newKey in last) || Array.isArray(last[newKey])) return last;
  }
  const created: Params = {};
  existing.push(created);
  return created;
}

async function magicFieldValue(value: string): Promise<JqValue> {
  if (value.startsWith('@')) return readUserFile(value.slice(1));
  if (/^[+-]?[0-9]+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  return value;
}

function groupGraphQLVariables(params: Params): Params {
  const top: Params = {};
  const variables: Params = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'query' || key === 'operationName') top[key] = value;
    else variables[key] = value;
  }
  if (Object.keys(variables).length > 0) top.variables = variables;
  return top;
}

/** Go url.Values.Encode: keys sorted; arrays as key[]; nested maps flatten to their subkeys. */
function addQuery(path: string, params: Params): string {
  if (Object.keys(params).length === 0) return path;
  const pairs: Array<[string, string]> = [];
  const add = (key: string, value: JqValue) => {
    if (value === null) pairs.push([key, '']);
    else if (Array.isArray(value)) for (const entry of value) add(`${key}[]`, entry);
    else if (typeof value === 'object')
      for (const [subkey, entry] of Object.entries(value)) add(subkey, entry);
    else pairs.push([key, String(value)]);
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  const byKey = new Map<string, string[]>();
  for (const [key, value] of pairs) byKey.set(key, [...(byKey.get(key) ?? []), value]);
  const query = [...byKey.keys()]
    .sort()
    .flatMap((key) =>
      byKey.get(key)!.map((value) => `${goQueryEscape(key)}=${goQueryEscape(value)}`),
    )
    .join('&');
  return `${path}${path.includes('?') ? '&' : '?'}${query}`;
}

function goQueryEscape(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function addPerPage(path: string, perPage: number, params: Params): string {
  if ('per_page' in params) return path;
  const idx = path.indexOf('?');
  if (idx >= 0) {
    if (new URLSearchParams(path.slice(idx + 1)).get('per_page')) return path;
    return `${path}&per_page=${perPage}`;
  }
  return `${path}?per_page=${perPage}`;
}

function findNextPage(link: string | undefined): string | undefined {
  if (!link) return undefined;
  for (const match of link.matchAll(/<([^>]+)>;\s*rel="([^"]+)"/g)) {
    if (match[2] === 'next') return match[1];
  }
  return undefined;
}

/** gh findEndCursor: first pageInfo values in document order; only a next page yields a cursor. */
function findEndCursor(document: JqValue): string {
  let endCursor = '';
  let hasNextPage = false;
  let foundCursor = false;
  let foundNext = false;
  const visit = (node: JqValue, containerKey: string): boolean => {
    if (Array.isArray(node)) {
      for (const item of node) if (visit(item, containerKey)) return true;
      return false;
    }
    if (node === null || typeof node !== 'object') return false;
    for (const [key, value] of Object.entries(node)) {
      if (containerKey === 'pageInfo' && key === 'endCursor' && typeof value === 'string') {
        endCursor = value;
        foundCursor = true;
        if (foundNext) return true;
      } else if (
        containerKey === 'pageInfo' &&
        key === 'hasNextPage' &&
        typeof value === 'boolean'
      ) {
        hasNextPage = value;
        foundNext = true;
        if (foundCursor) return true;
      } else if (value !== null && typeof value === 'object' && visit(value, key)) {
        return true;
      }
    }
    return false;
  };
  visit(document, '');
  return hasNextPage ? endCursor : '';
}

/** gh paginatedArrayReader: join JSON array pages into one array. */
function mergePageArray(text: string, isFirstPage: boolean, isLastPage: boolean): string {
  let out = text;
  if (!isFirstPage && out.startsWith('[')) out = (out[1] === ']' ? ' ' : ',') + out.slice(1);
  if (!isLastPage && out.endsWith(']')) out = out.slice(0, -1);
  return out;
}

/** gh parseErrorResponse: the message gh prints after "gh: ". */
function parseErrorResponse(body: string, status: number): string {
  let parsed: { message?: unknown; errors?: unknown };
  try {
    parsed = JSON.parse(body) as { message?: unknown; errors?: unknown };
  } catch (error) {
    // gh keeps an unparsable error body as output and falls back to the status line.
    if (!(error instanceof SyntaxError)) throw error;
    return '';
  }
  if (!parsed || typeof parsed !== 'object') return '';
  const message = typeof parsed.message === 'string' ? parsed.message : '';
  if (typeof parsed.errors === 'string' && parsed.errors !== '')
    return message ? `${parsed.errors} (${message})` : parsed.errors;
  if (message) return `${message} (HTTP ${status})`;
  if (!Array.isArray(parsed.errors)) return '';
  const messages = parsed.errors
    .map((error: unknown) =>
      typeof error === 'string'
        ? error
        : error && typeof error === 'object' && 'message' in error
          ? String((error as { message?: unknown }).message ?? '')
          : null,
    )
    .filter((item): item is string => item !== null);
  return messages.join('\n');
}

// ─── Porcelain helpers ───

interface RepoRef {
  host: string;
  owner: string;
  name: string;
}

function parseRepo(value: string | undefined, context: GhCommandContext): RepoRef {
  if (!value) throw new GhFailure('--repo is required');
  const fallbackHost = context.account?.host ?? defaultGitHubHost();
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(value);
  let host = fallbackHost;
  let path = value;
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else if (value.includes('://')) {
    const url = new URL(value);
    host = url.hostname;
    path = url.pathname;
  }
  const parts = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
    .split('/');
  if (parts.length === 3 && !scp && !value.includes('://')) [host] = parts.splice(0, 1);
  if (parts.length !== 2 || !parts[0] || !parts[1])
    throw new GhFailure(`expected the "[HOST/]OWNER/REPO" format, got "${value}"`);
  return { host: host.replace(/^www\./, '').toLowerCase(), owner: parts[0], name: parts[1] };
}

function parseNumber(value: string | undefined): number {
  if (!value || !/^#?[0-9]+$/.test(value))
    throw new GhFailure(`unsupported pull request selector: ${value ?? '(none)'}`);
  return Number(value.replace('#', ''));
}

function httpErrorMessage(response: GitHubHttpResponse): string {
  let message = `${response.status} ${response.statusText}`.trim();
  if (isJsonContentType(response.headers)) {
    message = '';
    try {
      const parsed = JSON.parse(response.body) as { message?: unknown; errors?: unknown };
      const messages: string[] = [];
      if (typeof parsed.message === 'string' && parsed.message) messages.push(parsed.message);
      if (Array.isArray(parsed.errors)) {
        for (const item of parsed.errors) {
          if (typeof item === 'string') messages.push(item);
          else if (item && typeof item === 'object' && typeof item.message === 'string')
            messages.push(item.message);
        }
      }
      message = messages.join('\n');
    } catch (error) {
      // go-gh reports an unparsable JSON error body by status and URL alone.
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  const [first, ...rest] = message.split('\n');
  if (!message) return `HTTP ${response.status} (${response.url})`;
  return `HTTP ${response.status}: ${first} (${response.url})${rest.length ? `\n${rest.join('\n')}` : ''}`;
}

interface GraphQLErrorItem {
  message?: string;
  path?: Array<string | number>;
}

function graphQLErrorMessage(errors: GraphQLErrorItem[]): string {
  return `GraphQL: ${errors
    .map((error) => {
      const path = (error.path ?? []).join('.');
      return path ? `${error.message ?? ''} (${path})` : (error.message ?? '');
    })
    .join(', ')}`;
}

interface PorcelainState {
  headers?: Map<string, string>;
  graphqlCost: number;
}

async function porcelainGraphQL<T>(
  host: string,
  query: string,
  variables: Params,
  context: GhCommandContext,
  state: PorcelainState,
): Promise<T> {
  const response = await send(
    host,
    {
      method: 'POST',
      url: graphqlEndpoint(host),
      headers: {
        Accept: GH_DEFAULT_ACCEPT,
        'Content-Type': JSON_CONTENT_TYPE,
        'GraphQL-Features': 'merge_queue',
      },
      body: JSON.stringify({ query, variables }),
    },
    context,
  );
  state.headers = response.headers;
  state.graphqlCost += graphqlCostOf(response.body) || 1;
  if (response.status > 299) throw new GhFailure(httpErrorMessage(response));
  const parsed = parseJson(response.body) as { data?: T; errors?: GraphQLErrorItem[] };
  if (parsed.errors?.length) throw new GhFailure(graphQLErrorMessage(parsed.errors));
  if (!parsed.data) throw new GhFailure('GraphQL response had no data');
  return parsed.data;
}

async function porcelainRest(
  host: string,
  method: string,
  path: string,
  body: Params | undefined,
  context: GhCommandContext,
  state: PorcelainState,
): Promise<JsonObject> {
  const response = await send(
    host,
    {
      method,
      url: restPrefix(host) + path,
      headers: { Accept: GH_DEFAULT_ACCEPT, 'Content-Type': JSON_CONTENT_TYPE },
      body: body ? JSON.stringify(body) : undefined,
    },
    context,
  );
  state.headers = response.headers;
  if (response.status > 299) throw new GhFailure(httpErrorMessage(response));
  return response.status === 204 ? {} : (parseJson(response.body) as JsonObject);
}

function exportOutput(data: JqValue, jq: string | undefined): string {
  return jq ? runGitHubJq(jq, data) : `${encodeGoJson(data, GO_EXPORT_ENCODING)}\n`;
}

function jsonFields(flags: ParsedFlags): string[] {
  const value = lastValue(flags, 'json');
  if (!value) throw new GhFailure('--json is required');
  return value.split(',').map((field) => field.trim());
}

// ─── gh pr view / list (export_pr.go shapes) ───

const SCALAR_STRING_FIELDS = new Set([
  'title',
  'state',
  'url',
  'body',
  'mergeable',
  'mergeStateStatus',
  'reviewDecision',
  'headRefName',
  'headRefOid',
  'baseRefName',
]);
const TIME_FIELDS = new Set(['createdAt', 'updatedAt']);
const NULLABLE_TIME_FIELDS = new Set(['closedAt', 'mergedAt']);

const PR_REVIEWS_QUERY =
  'reviews(first: 100){nodes{id,author{login},authorAssociation,submittedAt,body,state,commit{oid},reactionGroups{content,users{totalCount}}},pageInfo{hasNextPage,endCursor},totalCount}';

function prFieldQuery(fields: string[]): string {
  return fields
    .map((field) => {
      if (field === 'author') return 'author{login,...on User{id,name}}';
      if (field === 'headRepository') return 'headRepository{id,name,nameWithOwner}';
      if (field === 'reviews') return PR_REVIEWS_QUERY;
      if (
        field === 'number' ||
        field === 'isDraft' ||
        SCALAR_STRING_FIELDS.has(field) ||
        TIME_FIELDS.has(field) ||
        NULLABLE_TIME_FIELDS.has(field)
      )
        return field;
      throw new GhFailure(`Unknown JSON field: "${field}"`);
    })
    .join(',');
}

function asObject(value: JqValue | undefined): JsonObject | null {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function asString(value: JqValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function exportPR(pr: JsonObject, fields: string[]): JsonObject {
  const data: JsonObject = {};
  for (const field of fields) {
    const value = pr[field];
    if (field === 'number') data[field] = typeof value === 'number' ? value : 0;
    else if (field === 'isDraft') data[field] = value === true;
    else if (SCALAR_STRING_FIELDS.has(field)) data[field] = asString(value);
    else if (TIME_FIELDS.has(field)) data[field] = asString(value) || ZERO_TIME;
    else if (NULLABLE_TIME_FIELDS.has(field)) data[field] = asString(value) || null;
    else if (field === 'author') data[field] = exportAuthor(asObject(value));
    else if (field === 'headRepository') {
      const repo = asObject(value);
      data[field] = repo
        ? goStruct({
            id: asString(repo.id),
            name: asString(repo.name),
            nameWithOwner: asString(repo.nameWithOwner),
          })
        : null;
    } else if (field === 'reviews') {
      const nodes = asObject(value)?.nodes;
      data[field] = Array.isArray(nodes) ? nodes.map((node) => exportReview(asObject(node))) : [];
    }
  }
  return data;
}

/** api.Author.MarshalJSON: actors without a User id export as bots. */
function exportAuthor(author: JsonObject | null): JsonObject {
  const id = asString(author?.id);
  const login = asString(author?.login);
  if (!id) return { is_bot: true, login: `app/${login}` };
  return { is_bot: false, login, id, name: asString(author?.name) };
}

/** api.PullRequestReview: a Go struct, so its JSON keeps field order. */
function exportReview(review: JsonObject | null): JsonObject {
  const groups = review?.reactionGroups;
  return goStruct({
    id: asString(review?.id),
    author: goStruct({ login: asString(asObject(review?.author)?.login) }),
    authorAssociation: asString(review?.authorAssociation),
    body: asString(review?.body),
    submittedAt: asString(review?.submittedAt) || null,
    includesCreatedEdit: false,
    reactionGroups: Array.isArray(groups)
      ? groups
          .map((group) => asObject(group))
          .filter((group): group is JsonObject => {
            const count = asObject(group?.users)?.totalCount;
            return typeof count === 'number' && count > 0;
          })
          .map((group) =>
            goStruct({
              content: asString(group.content),
              users: goStruct({ totalCount: asObject(group.users)!.totalCount }),
            }),
          )
      : [],
    state: asString(review?.state),
    commit: goStruct({ oid: asString(asObject(review?.commit)?.oid) }),
  });
}

const PR_VIEW_FLAGS: FlagSpec = {
  values: { '--repo': 'repo', '-R': 'repo', '--json': 'json', '--jq': 'jq', '-q': 'jq' },
  booleans: {},
};

async function runPrView(argv: string[], context: GhCommandContext): Promise<GhCommandResult> {
  const flags = parseFlags(argv, PR_VIEW_FLAGS);
  const repo = parseRepo(lastValue(flags, 'repo'), context);
  const number = parseNumber(flags.positionals[0]);
  const fields = jsonFields(flags);
  const state: PorcelainState = { graphqlCost: 0 };
  const data = await porcelainGraphQL<{ repository?: { pullRequest?: JsonObject } }>(
    repo.host,
    `query PullRequestByNumber($owner: String!, $repo: String!, $pr_number: Int!) {repository(owner: $owner, name: $repo) {pullRequest(number: $pr_number) {id,${prFieldQuery(fields)}}} rateLimit{cost}}`,
    { owner: repo.owner, repo: repo.name, pr_number: number },
    context,
    state,
  );
  const pr = data.repository?.pullRequest;
  if (!pr) throw new GhFailure(`no pull requests found for number ${number}`);
  return {
    stdout: exportOutput(exportPR(pr, fields), lastValue(flags, 'jq')),
    stderr: '',
    headers: state.headers,
    graphqlCost: state.graphqlCost,
  };
}

const PR_LIST_FLAGS: FlagSpec = {
  values: {
    '--repo': 'repo',
    '-R': 'repo',
    '--json': 'json',
    '--jq': 'jq',
    '-q': 'jq',
    '--head': 'head',
    '-H': 'head',
    '--base': 'base',
    '-B': 'base',
    '--state': 'state',
    '-s': 'state',
    '--limit': 'limit',
    '-L': 'limit',
  },
  booleans: {},
};

const PR_LIST_STATES: Record<string, string[]> = {
  open: ['OPEN'],
  closed: ['CLOSED', 'MERGED'],
  merged: ['MERGED'],
  all: ['OPEN', 'CLOSED', 'MERGED'],
};

async function runPrList(argv: string[], context: GhCommandContext): Promise<GhCommandResult> {
  const flags = parseFlags(argv, PR_LIST_FLAGS);
  if (flags.positionals.length) throw new GhFailure('unexpected arguments');
  const repo = parseRepo(lastValue(flags, 'repo'), context);
  const fields = jsonFields(flags);
  const limit = Number(lastValue(flags, 'limit') ?? '30');
  if (!Number.isInteger(limit) || limit < 1)
    throw new GhFailure(`invalid value for --limit: ${limit}`);
  const states = PR_LIST_STATES[lastValue(flags, 'state') ?? 'open'];
  if (!states) throw new GhFailure(`invalid state: ${lastValue(flags, 'state')}`);
  const variables: Params = { owner: repo.owner, repo: repo.name, state: states };
  const head = lastValue(flags, 'head');
  const base = lastValue(flags, 'base');
  if (head) variables.headBranch = head;
  if (base) variables.baseBranch = base;
  const query = `query PullRequestList($owner: String!, $repo: String!, $limit: Int!, $endCursor: String, $baseBranch: String, $headBranch: String, $state: [PullRequestState!] = OPEN) {repository(owner: $owner, name: $repo) {pullRequests(states: $state, baseRefName: $baseBranch, headRefName: $headBranch, first: $limit, after: $endCursor, orderBy: {field: CREATED_AT, direction: DESC}) {totalCount nodes {${prFieldQuery(fields.includes('number') ? fields : [...fields, 'number'])}} pageInfo {hasNextPage endCursor}}} rateLimit{cost}}`;
  const state: PorcelainState = { graphqlCost: 0 };
  const seen = new Set<number>();
  const prs: JsonObject[] = [];
  let pageLimit = Math.min(limit, 100);
  for (;;) {
    variables.limit = pageLimit;
    const data = await porcelainGraphQL<{
      repository?: {
        pullRequests?: {
          nodes?: JsonObject[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        };
      };
    }>(repo.host, query, variables, context, state);
    const page = data.repository?.pullRequests;
    let done = false;
    for (const pr of page?.nodes ?? []) {
      const number = typeof pr.number === 'number' ? pr.number : 0;
      if (number > 0 && seen.has(number)) continue;
      seen.add(number);
      prs.push(pr);
      if (prs.length === limit) {
        done = true;
        break;
      }
    }
    if (done || !page?.pageInfo?.hasNextPage) break;
    variables.endCursor = page.pageInfo.endCursor ?? null;
    pageLimit = Math.min(pageLimit, limit - prs.length);
  }
  return {
    stdout: exportOutput(
      prs.map((pr) => exportPR(pr, fields)),
      lastValue(flags, 'jq'),
    ),
    stderr: '',
    headers: state.headers,
    graphqlCost: state.graphqlCost,
  };
}

// ─── gh pr checks (pkg/cmd/pr/checks/aggregate.go) ───

const CHECK_FIELDS = new Set([
  'name',
  'state',
  'startedAt',
  'completedAt',
  'link',
  'bucket',
  'event',
  'workflow',
  'description',
]);

interface CheckContextNode {
  __typename?: string;
  name?: string;
  context?: string;
  state?: string;
  status?: string;
  conclusion?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  detailsUrl?: string;
  targetUrl?: string;
  description?: string;
  checkSuite?: { workflowRun?: { event?: string; workflow?: { name?: string } } | null } | null;
}

function checkBucket(state: string): string {
  if (state === 'SUCCESS') return 'pass';
  if (state === 'SKIPPED' || state === 'NEUTRAL') return 'skipping';
  if (['ERROR', 'FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(state)) return 'fail';
  if (state === 'CANCELLED') return 'cancel';
  return 'pending';
}

function aggregateChecks(contexts: CheckContextNode[]): JsonObject[] {
  const startedAt = (node: CheckContextNode) => Date.parse(node.startedAt || ZERO_TIME);
  const sorted = contexts.slice().sort((a, b) => startedAt(b) - startedAt(a));
  const seenChecks = new Set<string>();
  const seenContexts = new Set<string>();
  const checks: JsonObject[] = [];
  for (const node of sorted) {
    const run = node.checkSuite?.workflowRun;
    if (node.context) {
      if (seenContexts.has(node.context)) continue;
      seenContexts.add(node.context);
    } else {
      const key = `${node.name ?? ''}/${run?.workflow?.name ?? ''}/${run?.event ?? ''}`;
      if (seenChecks.has(key)) continue;
      seenChecks.add(key);
    }
    const state =
      node.state || (node.status === 'COMPLETED' ? (node.conclusion ?? '') : (node.status ?? ''));
    checks.push({
      name: node.name || node.context || '',
      state,
      startedAt: node.startedAt || ZERO_TIME,
      completedAt: node.completedAt || ZERO_TIME,
      link: node.detailsUrl || node.targetUrl || '',
      bucket: checkBucket(state),
      event: run?.event ?? '',
      workflow: run?.workflow?.name ?? '',
      description: node.description ?? '',
    });
  }
  return checks;
}

const PR_CHECKS_QUERY =
  'query PullRequestStatusChecks($owner: String!, $repo: String!, $pr_number: Int!, $endCursor: String) {repository(owner: $owner, name: $repo) {pullRequest(number: $pr_number) {headRefName statusCheckRollup: commits(last: 1) {nodes {commit {statusCheckRollup {contexts(first: 100, after: $endCursor) {nodes {__typename ...on StatusContext {context,state,targetUrl,createdAt,description} ...on CheckRun {name,checkSuite{workflowRun{event,workflow{name}}},status,conclusion,startedAt,completedAt,detailsUrl}} pageInfo{hasNextPage,endCursor}}}}}}}} rateLimit{cost}}';

async function runPrChecks(argv: string[], context: GhCommandContext): Promise<GhCommandResult> {
  const flags = parseFlags(argv, PR_VIEW_FLAGS);
  const repo = parseRepo(lastValue(flags, 'repo'), context);
  const number = parseNumber(flags.positionals[0]);
  const fields = jsonFields(flags);
  for (const field of fields)
    if (!CHECK_FIELDS.has(field)) throw new GhFailure(`Unknown JSON field: "${field}"`);
  const state: PorcelainState = { graphqlCost: 0 };
  const variables: Params = { owner: repo.owner, repo: repo.name, pr_number: number };
  const contexts: CheckContextNode[] = [];
  let headRefName = '';
  for (;;) {
    const data = await porcelainGraphQL<{
      repository?: {
        pullRequest?: {
          headRefName?: string;
          statusCheckRollup?: {
            nodes?: Array<{
              commit?: {
                statusCheckRollup?: {
                  contexts?: {
                    nodes?: CheckContextNode[];
                    pageInfo?: { hasNextPage?: boolean; endCursor?: string };
                  };
                } | null;
              };
            }>;
          };
        } | null;
      };
    }>(repo.host, PR_CHECKS_QUERY, variables, context, state);
    const pr = data.repository?.pullRequest;
    if (!pr) throw new GhFailure(`no pull requests found for number ${number}`);
    headRefName = pr.headRefName ?? '';
    const commits = pr.statusCheckRollup?.nodes ?? [];
    if (commits.length === 0) throw new GhFailure('no commit found on the pull request');
    const result = commits[0].commit?.statusCheckRollup?.contexts;
    contexts.push(...(result?.nodes ?? []));
    if (!result?.pageInfo?.hasNextPage) break;
    variables.endCursor = result.pageInfo.endCursor ?? null;
  }
  if (contexts.length === 0)
    throw new GhFailure(`no checks reported on the '${headRefName}' branch`);
  const checks = aggregateChecks(contexts).map((check) =>
    Object.fromEntries(fields.map((field) => [field, check[field]])),
  );
  return {
    stdout: exportOutput(checks, lastValue(flags, 'jq')),
    stderr: '',
    headers: state.headers,
    graphqlCost: state.graphqlCost,
  };
}

// ─── gh pr create / edit / comment / ready ───

const PR_WRITE_FLAGS: FlagSpec = {
  values: {
    '--repo': 'repo',
    '-R': 'repo',
    '--head': 'head',
    '-H': 'head',
    '--base': 'base',
    '-B': 'base',
    '--title': 'title',
    '-t': 'title',
    '--body': 'body',
    '-b': 'body',
    '--body-file': 'body-file',
    '-F': 'body-file',
  },
  booleans: { '--draft': 'draft', '-d': 'draft' },
};

async function bodyFlag(flags: ParsedFlags): Promise<string | undefined> {
  const file = lastValue(flags, 'body-file');
  return file !== undefined ? readUserFile(file) : lastValue(flags, 'body');
}

async function runPrWrite(
  subcommand: 'create' | 'edit' | 'comment' | 'ready',
  argv: string[],
  context: GhCommandContext,
): Promise<GhCommandResult> {
  const flags = parseFlags(argv, PR_WRITE_FLAGS);
  const repo = parseRepo(lastValue(flags, 'repo'), context);
  const prefix = `repos/${repo.owner}/${repo.name}`;
  const state: PorcelainState = { graphqlCost: 0 };
  const done = (stdout: string): GhCommandResult => ({
    stdout,
    stderr: '',
    headers: state.headers,
  });
  const body = await bodyFlag(flags);
  if (subcommand === 'create') {
    const title = lastValue(flags, 'title');
    const head = lastValue(flags, 'head');
    const base = lastValue(flags, 'base');
    if (title === undefined || !head || !base || body === undefined)
      throw new GhFailure('pr create needs --head, --base, --title and a body');
    const created = await porcelainRest(
      repo.host,
      'POST',
      `${prefix}/pulls`,
      { title, head, base, body, draft: flags.booleans.has('draft') },
      context,
      state,
    );
    return done(`${asString(created.html_url)}\n`);
  }
  const number = parseNumber(flags.positionals[0]);
  if (subcommand === 'edit') {
    const title = lastValue(flags, 'title');
    const update: Params = {};
    if (title !== undefined) update.title = title;
    if (body !== undefined) update.body = body;
    if (Object.keys(update).length === 0) throw new GhFailure('pr edit needs --title or a body');
    const edited = await porcelainRest(
      repo.host,
      'PATCH',
      `${prefix}/pulls/${number}`,
      update,
      context,
      state,
    );
    return done(`${asString(edited.html_url)}\n`);
  }
  if (subcommand === 'comment') {
    if (body === undefined) throw new GhFailure('pr comment needs a body');
    const comment = await porcelainRest(
      repo.host,
      'POST',
      `${prefix}/issues/${number}/comments`,
      { body },
      context,
      state,
    );
    return done(`${asString(comment.html_url)}\n`);
  }
  const pr = await porcelainRest(
    repo.host,
    'GET',
    `${prefix}/pulls/${number}`,
    undefined,
    context,
    state,
  );
  if (pr.state === 'closed')
    throw new GhFailure(
      `Pull request ${repo.owner}/${repo.name}#${number} is closed. Only draft pull requests can be marked as "ready for review"`,
    );
  if (pr.draft !== true) return done('');
  await porcelainGraphQL(
    repo.host,
    'mutation PullRequestReadyForReview($id: ID!) {markPullRequestReadyForReview(input: {pullRequestId: $id}) {clientMutationId}}',
    { id: asString(pr.node_id) },
    context,
    state,
  );
  return done('');
}

async function runPr(
  subcommand: string | undefined,
  argv: string[],
  context: GhCommandContext,
): Promise<GhCommandResult> {
  if (subcommand === 'view') return runPrView(argv, context);
  if (subcommand === 'list') return runPrList(argv, context);
  if (subcommand === 'checks') return runPrChecks(argv, context);
  if (
    subcommand === 'create' ||
    subcommand === 'edit' ||
    subcommand === 'comment' ||
    subcommand === 'ready'
  )
    return runPrWrite(subcommand, argv, context);
  throw new GhFailure(`unsupported gh command: pr ${subcommand ?? ''}`);
}

// ─── gh repo view ───

async function runRepoView(argv: string[], context: GhCommandContext): Promise<GhCommandResult> {
  const flags = parseFlags(argv, {
    values: { '--json': 'json', '--jq': 'jq', '-q': 'jq' },
    booleans: {},
  });
  if (flags.positionals.length !== 1) throw new GhFailure('repo view needs a repository');
  const repo = parseRepo(flags.positionals[0], context);
  const fields = jsonFields(flags);
  for (const field of fields)
    if (field !== 'nameWithOwner') throw new GhFailure(`Unknown JSON field: "${field}"`);
  const state: PorcelainState = { graphqlCost: 0 };
  const data = await porcelainRest(
    repo.host,
    'GET',
    `repos/${repo.owner}/${repo.name}`,
    undefined,
    context,
    state,
  );
  return {
    stdout: exportOutput({ nameWithOwner: asString(data.full_name) }, lastValue(flags, 'jq')),
    stderr: '',
    headers: state.headers,
  };
}
