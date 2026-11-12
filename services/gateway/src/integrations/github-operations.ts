// github-operations.ts — typed GitHub operations the gateway exposes via GitHubService.
// HTTP transport, credential management, conditional GETs, porcelain GraphQL/REST helpers,
// and exported Op functions (prView, prList, prChecks, prCreate/Edit/Comment/Ready,
// repoView, graphql, rest).
import { GitHubHttpError } from './github-errors.js';
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

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

/** Identity wrapper: marks an object built from typed fields (no encoding side effect). */
function goStruct<T extends JsonObject>(value: T): T {
  return value;
}

export interface GhAccount {
  host: string;
  token: string;
  scope: string;
}

export interface GhCommandContext {
  signal?: AbortSignal;
  account?: GhAccount;
}

const GH_DEFAULT_ACCEPT =
  'application/vnd.github.merge-info-preview+json, application/vnd.github.nebula-preview';
const ZERO_TIME = '0001-01-01T00:00:00Z';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

class GhFailure extends Error {}

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

type Params = { [key: string]: JsonValue };

function parseJson(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
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

function findNextPage(link: string | undefined): string | undefined {
  if (!link) return undefined;
  for (const match of link.matchAll(/<([^>]+)>;\s*rel="([^"]+)"/g)) {
    if (match[2] === 'next') return match[1];
  }
  return undefined;
}

/** gh paginatedArrayReader: join JSON array pages into one array. */
function mergePageArray(text: string, isFirstPage: boolean, isLastPage: boolean): string {
  let out = text;
  if (!isFirstPage && out.startsWith('[')) out = (out[1] === ']' ? ' ' : ',') + out.slice(1);
  if (!isLastPage && out.endsWith(']')) out = out.slice(0, -1);
  return out;
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

function httpErrorMessage(response: GitHubHttpResponse): string {
  if (isJsonContentType(response.headers)) {
    let message = '';
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
    if (!message) return `HTTP ${response.status} (${response.url})`;
    const [first, ...rest] = message.split('\n');
    return `gh: ${first} (HTTP ${response.status})${rest.length ? `\n${rest.join('\n')}` : ''}`;
  }
  const message = `${response.status} ${response.statusText}`.trim();
  if (!message) return `HTTP ${response.status} (${response.url})`;
  const [first, ...rest] = message.split('\n');
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
  if (response.status > 299)
    throw new GitHubHttpError(response.status, httpErrorMessage(response), response.headers);
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
  if (response.status > 299)
    throw new GitHubHttpError(response.status, httpErrorMessage(response), response.headers);
  return response.status === 204 ? {} : (parseJson(response.body) as JsonObject);
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

function asObject(value: JsonValue | undefined): JsonObject | null {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function asString(value: JsonValue | undefined): string {
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

// ─── Typed service operations (no gh arg grammar) ───
// Called directly from github-client.ts. Each returns { data, headers, graphqlCost? }.

/** Returned by every typed operation so the client middleware can observe quota + spend. */
export interface GitHubOpResult<T> {
  data: T;
  headers?: Map<string, string>;
  /** GraphQL points consumed (operations that issued at least one GraphQL request). */
  graphqlCost?: number;
}

/** Filters for `githubPrListOp`. */
export interface PRListFilters {
  head?: string;
  base?: string;
  state?: 'open' | 'closed' | 'merged' | 'all';
  limit?: number;
}

/** Parameters for `githubPrCreateOp`. */
export interface PRCreateParams {
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}

/** Parameters for `githubPrEditOp`. */
export interface PREditParams {
  title?: string;
  body?: string;
}

/** Options for `githubRestOp`. */
export interface RestOpOpts {
  paginate?: boolean;
  slurp?: boolean;
  perPage?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Return the raw response body string instead of JSON-parsing it (e.g. diff/patch endpoints). */
  raw?: boolean;
}

// ─── PR list states (used by githubPrListOp / githubPrListFieldsOp) ───

const PR_LIST_STATES: Record<string, string[]> = {
  open: ['OPEN'],
  closed: ['CLOSED', 'MERGED'],
  merged: ['MERGED'],
  all: ['OPEN', 'CLOSED', 'MERGED'],
};

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

export async function githubPrViewOp(
  repo: string,
  prNumber: number,
  fields: string[],
  ctx: GhCommandContext,
): Promise<GitHubOpResult<JsonObject>> {
  const ref = parseRepo(repo, ctx);
  const state: PorcelainState = { graphqlCost: 0 };
  const data = await porcelainGraphQL<{ repository?: { pullRequest?: JsonObject } }>(
    ref.host,
    `query PullRequestByNumber($owner: String!, $repo: String!, $pr_number: Int!) {repository(owner: $owner, name: $repo) {pullRequest(number: $pr_number) {id,${prFieldQuery(fields)}}} rateLimit{cost}}`,
    { owner: ref.owner, repo: ref.name, pr_number: prNumber },
    ctx,
    state,
  );
  const pr = data.repository?.pullRequest;
  if (!pr) throw new GhFailure(`no pull requests found for number ${prNumber}`);
  if (fields.includes('reviews')) pr.reviews = await preloadReviews(ref, prNumber, pr, ctx, state);
  return { data: exportPR(pr, fields), headers: state.headers, graphqlCost: state.graphqlCost };
}

const PR_REVIEWS_PAGE_QUERY = `query PullRequestReviews($owner: String!, $repo: String!, $pr_number: Int!, $endCursor: String) {repository(owner: $owner, name: $repo) {pullRequest(number: $pr_number) {${PR_REVIEWS_QUERY.replace('reviews(first: 100)', 'reviews(first: 100, after: $endCursor)')}}} rateLimit{cost}}`;

/** gh preloadPrReviews: follow the reviews connection past its first 100 nodes. */
async function preloadReviews(
  ref: RepoRef,
  prNumber: number,
  pr: JsonObject,
  ctx: GhCommandContext,
  state: PorcelainState,
): Promise<JsonObject> {
  let page = asObject(pr.reviews);
  const nodes: JsonValue[] = [];
  for (;;) {
    if (Array.isArray(page?.nodes)) nodes.push(...page.nodes);
    const pageInfo = asObject(page?.pageInfo);
    if (pageInfo?.hasNextPage !== true || typeof pageInfo.endCursor !== 'string') break;
    const data = await porcelainGraphQL<{
      repository?: { pullRequest?: { reviews?: JsonObject } | null };
    }>(
      ref.host,
      PR_REVIEWS_PAGE_QUERY,
      { owner: ref.owner, repo: ref.name, pr_number: prNumber, endCursor: pageInfo.endCursor },
      ctx,
      state,
    );
    page = asObject(data.repository?.pullRequest?.reviews);
  }
  return { nodes };
}

export async function githubPrListOp(
  repo: string,
  filters: PRListFilters,
  ctx: GhCommandContext,
): Promise<GitHubOpResult<JsonObject[]>> {
  const ref = parseRepo(repo, ctx);
  const limit = filters.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1) throw new GhFailure(`invalid limit: ${limit}`);
  const states = PR_LIST_STATES[filters.state ?? 'open'];
  if (!states) throw new GhFailure(`invalid state: ${String(filters.state)}`);
  const variables: Params = { owner: ref.owner, repo: ref.name, state: states };
  if (filters.head) variables.headBranch = filters.head;
  if (filters.base) variables.baseBranch = filters.base;
  const query = `query PullRequestList($owner: String!, $repo: String!, $limit: Int!, $endCursor: String, $baseBranch: String, $headBranch: String, $state: [PullRequestState!] = OPEN) {repository(owner: $owner, name: $repo) {pullRequests(states: $state, baseRefName: $baseBranch, headRefName: $headBranch, first: $limit, after: $endCursor, orderBy: {field: CREATED_AT, direction: DESC}) {totalCount nodes {number} pageInfo {hasNextPage endCursor}}} rateLimit{cost}}`;
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
    }>(ref.host, query, variables, ctx, state);
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
  return { data: prs, headers: state.headers, graphqlCost: state.graphqlCost };
}

/** Full prList with field selection (used by raw-cache prefetch which requests specific fields). */
export async function githubPrListFieldsOp(
  repo: string,
  fields: string[],
  filters: PRListFilters,
  ctx: GhCommandContext,
): Promise<GitHubOpResult<JsonObject[]>> {
  const ref = parseRepo(repo, ctx);
  const limit = filters.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1) throw new GhFailure(`invalid limit: ${limit}`);
  const states = PR_LIST_STATES[filters.state ?? 'open'];
  if (!states) throw new GhFailure(`invalid state: ${String(filters.state)}`);
  const variables: Params = { owner: ref.owner, repo: ref.name, state: states };
  if (filters.head) variables.headBranch = filters.head;
  if (filters.base) variables.baseBranch = filters.base;
  const allFields = fields.includes('number') ? fields : [...fields, 'number'];
  const query = `query PullRequestList($owner: String!, $repo: String!, $limit: Int!, $endCursor: String, $baseBranch: String, $headBranch: String, $state: [PullRequestState!] = OPEN) {repository(owner: $owner, name: $repo) {pullRequests(states: $state, baseRefName: $baseBranch, headRefName: $headBranch, first: $limit, after: $endCursor, orderBy: {field: CREATED_AT, direction: DESC}) {totalCount nodes {${prFieldQuery(allFields)}} pageInfo {hasNextPage endCursor}}} rateLimit{cost}}`;
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
    }>(ref.host, query, variables, ctx, state);
    const page = data.repository?.pullRequests;
    let done = false;
    for (const pr of page?.nodes ?? []) {
      const number = typeof pr.number === 'number' ? pr.number : 0;
      if (number > 0 && seen.has(number)) continue;
      seen.add(number);
      prs.push(exportPR(pr, fields));
      if (prs.length === limit) {
        done = true;
        break;
      }
    }
    if (done || !page?.pageInfo?.hasNextPage) break;
    variables.endCursor = page.pageInfo.endCursor ?? null;
    pageLimit = Math.min(pageLimit, limit - prs.length);
  }
  return { data: prs, headers: state.headers, graphqlCost: state.graphqlCost };
}

export async function githubPrChecksOp(
  repo: string,
  prNumber: number,
  fields: string[],
  ctx: GhCommandContext,
): Promise<GitHubOpResult<JsonObject[]>> {
  for (const field of fields)
    if (!CHECK_FIELDS.has(field)) throw new GhFailure(`Unknown JSON field: "${field}"`);
  const ref = parseRepo(repo, ctx);
  const state: PorcelainState = { graphqlCost: 0 };
  const variables: Params = { owner: ref.owner, repo: ref.name, pr_number: prNumber };
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
    }>(ref.host, PR_CHECKS_QUERY, variables, ctx, state);
    const pr = data.repository?.pullRequest;
    if (!pr) throw new GhFailure(`no pull requests found for number ${prNumber}`);
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
  return { data: checks, headers: state.headers, graphqlCost: state.graphqlCost };
}

export async function githubPrCreateOp(
  repo: string,
  params: PRCreateParams,
  ctx: GhCommandContext,
): Promise<GitHubOpResult<string>> {
  const ref = parseRepo(repo, ctx);
  const prefix = `repos/${ref.owner}/${ref.name}`;
  const state: PorcelainState = { graphqlCost: 0 };
  const created = await porcelainRest(
    ref.host,
    'POST',
    `${prefix}/pulls`,
    {
      title: params.title,
      head: params.head,
      base: params.base,
      body: params.body,
      draft: params.draft === true,
    },
    ctx,
    state,
  );
  return { data: `${asString(created.html_url)}\n`, headers: state.headers };
}

export async function githubPrEditOp(
  repo: string,
  prNumber: number,
  params: PREditParams,
  ctx: GhCommandContext,
): Promise<GitHubOpResult<string>> {
  const ref = parseRepo(repo, ctx);
  const prefix = `repos/${ref.owner}/${ref.name}`;
  const state: PorcelainState = { graphqlCost: 0 };
  const update: Params = {};
  if (params.title !== undefined) update.title = params.title;
  if (params.body !== undefined) update.body = params.body;
  if (Object.keys(update).length === 0) throw new GhFailure('pr edit needs title or body');
  const edited = await porcelainRest(
    ref.host,
    'PATCH',
    `${prefix}/pulls/${prNumber}`,
    update,
    ctx,
    state,
  );
  return { data: `${asString(edited.html_url)}\n`, headers: state.headers };
}

export async function githubPrCommentOp(
  repo: string,
  prNumber: number,
  body: string,
  ctx: GhCommandContext,
): Promise<GitHubOpResult<string>> {
  const ref = parseRepo(repo, ctx);
  const prefix = `repos/${ref.owner}/${ref.name}`;
  const state: PorcelainState = { graphqlCost: 0 };
  const comment = await porcelainRest(
    ref.host,
    'POST',
    `${prefix}/issues/${prNumber}/comments`,
    { body },
    ctx,
    state,
  );
  return { data: `${asString(comment.html_url)}\n`, headers: state.headers };
}

export async function githubPrReadyOp(
  repo: string,
  prNumber: number,
  ctx: GhCommandContext,
): Promise<GitHubOpResult<void>> {
  const ref = parseRepo(repo, ctx);
  const prefix = `repos/${ref.owner}/${ref.name}`;
  const state: PorcelainState = { graphqlCost: 0 };
  const pr = await porcelainRest(
    ref.host,
    'GET',
    `${prefix}/pulls/${prNumber}`,
    undefined,
    ctx,
    state,
  );
  if (pr.state === 'closed')
    throw new GhFailure(
      `Pull request ${ref.owner}/${ref.name}#${prNumber} is closed. Only draft pull requests can be marked as "ready for review"`,
    );
  if (pr.draft !== true) return { data: undefined, headers: state.headers };
  await porcelainGraphQL(
    ref.host,
    'mutation PullRequestReadyForReview($id: ID!) {markPullRequestReadyForReview(input: {pullRequestId: $id}) {clientMutationId}}',
    { id: asString(pr.node_id) },
    ctx,
    state,
  );
  return { data: undefined, headers: state.headers, graphqlCost: state.graphqlCost };
}

export async function githubRepoViewOp(
  repo: string,
  ctx: GhCommandContext,
): Promise<GitHubOpResult<{ nameWithOwner: string }>> {
  const ref = parseRepo(repo, ctx);
  const state: PorcelainState = { graphqlCost: 0 };
  const data = await porcelainRest(
    ref.host,
    'GET',
    `repos/${ref.owner}/${ref.name}`,
    undefined,
    ctx,
    state,
  );
  return { data: { nameWithOwner: asString(data.full_name) }, headers: state.headers };
}

export async function githubGraphQLOp<T>(
  host: string,
  query: string,
  variables: Record<string, string | number | null>,
  ctx: GhCommandContext,
): Promise<GitHubOpResult<T>> {
  const state: PorcelainState = { graphqlCost: 0 };
  const data = await porcelainGraphQL<T>(host, query, variables as Params, ctx, state);
  return { data, headers: state.headers, graphqlCost: state.graphqlCost };
}

export async function githubRestOp<T>(
  host: string,
  method: string,
  path: string,
  opts: RestOpOpts,
  ctx: GhCommandContext,
): Promise<GitHubOpResult<T>> {
  const methodUpper = method.toUpperCase();
  const perPage = opts.perPage ?? (opts.paginate ? 100 : undefined);
  let url = path.includes('://') ? path : restPrefix(host) + path.replace(/^\//, '');
  if (perPage && methodUpper === 'GET' && !url.includes('per_page=')) {
    url = url.includes('?') ? `${url}&per_page=${perPage}` : `${url}?per_page=${perPage}`;
  }
  const headers: Record<string, string> = {
    Accept: '*/*',
    'Content-Type': 'application/json; charset=utf-8',
    ...opts.headers,
  };
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

  if (!opts.paginate) {
    const response = await send(host, { method: methodUpper, url, headers, body }, ctx);
    if (response.status > 299)
      throw new GitHubHttpError(response.status, httpErrorMessage(response), response.headers);
    if (opts.raw) return { data: response.body as T, headers: response.headers };
    // 204 No Content: body is empty; return null so callers that check can handle it.
    return { data: JSON.parse(response.body || 'null') as T, headers: response.headers };
  }

  // Paginated REST: follow Link rel="next" headers, join JSON arrays.
  const output: string[] = [];
  let lastHeaders: Map<string, string> | undefined;
  let pageCount = 0;
  for (;;) {
    const response = await send(
      host,
      { method: methodUpper, url, headers, body: pageCount === 0 ? body : undefined },
      ctx,
    );
    lastHeaders = response.headers;
    if (response.status > 299)
      throw new GitHubHttpError(response.status, httpErrorMessage(response), response.headers);
    const next = findNextPage(response.headers.get('link') ?? undefined);
    const isLastPage = !next;
    if (opts.slurp) {
      output.push(response.body);
    } else {
      output.push(mergePageArray(response.body, pageCount === 0, isLastPage));
    }
    pageCount++;
    if (isLastPage) break;
    // next is defined (truthy) because isLastPage is false
    url = next as string;
  }
  const joined = opts.slurp ? `[${output.join(',')}]` : output.join('');
  return { data: parseJson(joined) as T, headers: lastHeaders };
}
