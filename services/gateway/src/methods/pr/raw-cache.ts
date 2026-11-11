// methods/pr/raw-cache.ts — raw GitHub PR snapshot cache and GraphQL batch prefetch.

import { github } from '../../integrations/github-client.js';
import {
  githubQueryBudget,
  GitHubQueryBudgetError,
} from '../../integrations/github-query-budget.js';

// ─── GitHub raw-response cache ───
// Shields the GitHub API from the 60s UI poll + ci-monitor tick. Keyed by
// `repo/pr`; cached snapshots hold the stdout of the five gh calls that drive
// PRStatus. Per-call overlays (slot/workerActive/summary/familyContext) are
// re-derived fresh from the run store on every PRStatus build, so cache reuse
// does not stale-read run-side signals.
//
// force=true bypasses both this cache and the github service cache —
// used by explicit refresh flows (ciWatch.poke, UI manual refresh).

export interface PRRawSnapshot {
  author?: string;
  checksStdout: string;
  /** Successful complete check query, even when it returned zero rows. */
  checksAvailable?: boolean;
  prStateStdout: string;
  /** Why the PR state read returned nothing (gh's message); absent when it succeeded. */
  prStateError?: string;
  commentsStdout: string;
  reviewCommentsStdout: string;
  latestCommitStdout: string;
  /**
   * JSON lines, one per reviewer's latest *opinionated* review, i.e. the
   * APPROVED / CHANGES_REQUESTED verdict that still counts toward
   * reviewDecision even if they commented later
   * (`{t:"review",author,state,submittedAt}`), and one per outstanding review
   * request (`{t:"request",kind:"team"|"user",name}`).
   */
  reviewMetaStdout: string;
  fetchedAt: number;
  /** True when GraphQL first-page connections still have more nodes. */
  partial?: boolean;
  /** Component read failures are distinct from the last complete retained value. */
  errors?: string[];
}

export const PR_RAW_TTL_MS = 60 * 1000;
const prRawCache = new Map<string, PRRawSnapshot>();
const prRawInflight = new Map<string, Promise<PRRawSnapshot>>();
const retainedPRRaw = new Map<string, PRRawSnapshot>();
const observationListeners = new Set<(repo: string, pr: number) => void>();

export interface RetainedPRRawObservation {
  repo: string;
  pr: number;
  raw: PRRawSnapshot;
}

function rawKey(repo: string, pr: number): string {
  return `${repo.toLowerCase()}#${pr}`;
}

/** Reads the last observed upstream value without a TTL refresh or GitHub I/O. */
export function peekRetainedPRRawData(repo: string, pr: number): PRRawSnapshot | undefined {
  return retainedPRRaw.get(rawKey(repo, pr));
}

export function onPRRawObservation(listener: (repo: string, pr: number) => void): () => void {
  observationListeners.add(listener);
  return () => observationListeners.delete(listener);
}

function recordPRRawData(repo: string, pr: number, raw: PRRawSnapshot): void {
  prRawCache.set(rawKey(repo, pr), raw);
  // An outage's empty PR state is not a successful value for passive projections.
  if (!raw.prStateStdout.trim() || raw.errors?.length) return;
  retainedPRRaw.set(rawKey(repo, pr), raw);
  for (const listener of observationListeners) listener(repo, pr);
}

export function retainPRRawNotFound(repo: string, pr: number): void {
  const raw = prRawCache.get(rawKey(repo, pr));
  if (
    raw &&
    !raw.prStateStdout.trim() &&
    /HTTP 404|Could not resolve to a PullRequest/i.test(raw.prStateError ?? '')
  )
    retainedPRRaw.set(rawKey(repo, pr), raw);
}

export function retainedPRRawObservations(
  identities: readonly { repo: string; pr: number }[],
): RetainedPRRawObservation[] {
  const entries = new Map(
    identities.flatMap(({ repo, pr }) => {
      const raw = peekRetainedPRRawData(repo, pr);
      return raw ? [[rawKey(repo, pr), { repo, pr, raw }] as const] : [];
    }),
  );
  // Keep known absences too, so an older project snapshot cannot resurrect a removed PR.
  for (const [key, raw] of retainedPRRaw) {
    if (
      raw.prStateStdout.trim() ||
      !/HTTP 404|Could not resolve to a PullRequest/i.test(raw.prStateError ?? '')
    )
      continue;
    const split = key.lastIndexOf('#');
    entries.set(key, { repo: key.slice(0, split), pr: Number(key.slice(split + 1)), raw });
  }
  return [...entries.values()];
}

/** Restore already observed bytes; this never makes them fresh or emits a new observation. */
export function restoreRetainedPRRawObservations(value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    const raw = entry?.raw;
    if (
      typeof entry?.repo !== 'string' ||
      !Number.isSafeInteger(entry?.pr) ||
      entry.pr < 1 ||
      !raw ||
      typeof raw !== 'object' ||
      !Number.isFinite(raw.fetchedAt) ||
      (raw.errors !== undefined &&
        (!Array.isArray(raw.errors) ||
          !raw.errors.every((error: unknown) => typeof error === 'string'))) ||
      ![
        'checksStdout',
        'prStateStdout',
        'commentsStdout',
        'reviewCommentsStdout',
        'latestCommitStdout',
        'reviewMetaStdout',
      ].every((field) => typeof raw[field] === 'string') ||
      (raw.prStateStdout.trim() && raw.errors?.length) ||
      (!raw.prStateStdout.trim() &&
        !/HTTP 404|Could not resolve to a PullRequest/i.test(raw.prStateError ?? ''))
    )
      continue;
    const previous = peekRetainedPRRawData(entry.repo, entry.pr);
    if (!previous || raw.fetchedAt > previous.fetchedAt)
      retainedPRRaw.set(rawKey(entry.repo, entry.pr), raw as PRRawSnapshot);
  }
}

export function isUsablePRRawSnapshot(
  cached: PRRawSnapshot | undefined,
  now: number,
  opts: { force?: boolean; allowPartial?: boolean } = {},
): cached is PRRawSnapshot {
  if (!cached || opts.force) return false;
  if (now - cached.fetchedAt >= PR_RAW_TTL_MS) return false;
  if (cached.partial && !opts.allowPartial) return false;
  return true;
}

// swallowGh removed — getPRRawData migrated to github.graphql single-query path.

export function buildPRChecksArgs(prNum: number, ghRepo: string): string[] {
  // Plain `gh pr checks` exits with code 8 whenever any check is still pending.
  // That is valid state, not a transport failure, so fetch JSON buckets instead.
  return [
    'pr',
    'checks',
    String(prNum),
    '--repo',
    ghRepo,
    '--json',
    'name,bucket,startedAt,completedAt,state,link',
    '--jq',
    '.[] | [.name, .bucket, (.startedAt // ""), (.completedAt // ""), (.state // ""), (.link // "")] | @tsv',
  ];
}

export async function getPRRawData(
  ghRepo: string,
  prNum: number,
  force?: boolean,
  opts?: { allowPartial?: boolean },
): Promise<PRRawSnapshot> {
  const key = rawKey(ghRepo, prNum);
  if (!force) {
    const cached = prRawCache.get(key);
    if (isUsablePRRawSnapshot(cached, Date.now(), { allowPartial: opts?.allowPartial }))
      return cached;
    const inflight = prRawInflight.get(key);
    if (inflight) return inflight;
  }
  const fetchPromise = (async (): Promise<PRRawSnapshot> => {
    const [owner, name] = ghRepo.split('/');
    if (!owner || !name) {
      const snap = { ...EMPTY_PR_RAW_SNAPSHOT, fetchedAt: Date.now() };
      recordPRRawData(ghRepo, prNum, snap);
      return snap;
    }
    type SingleRepoData = {
      repository?: Record<string, GqlPullRequestNode | null | undefined> | null;
    };
    let prNode: GqlPullRequestNode | null | undefined;
    let prStateError: string | undefined;
    try {
      const data = await github.graphql<SingleRepoData>(
        buildBatchQuery(1),
        { owner, name, pr_0: prNum },
        { force: force ?? false },
      );
      prNode = data.repository?.pr_0;
    } catch (err) {
      if (err instanceof GitHubQueryBudgetError) throw err;
      prNode = null;
      prStateError = err instanceof Error ? err.message : String(err);
    }
    const snap = synthesizeRawSnapshotFromGraphQL(prNode);
    if (prStateError) snap.prStateError = prStateError;
    if (prNode && isPRBatchTruncated(prNode)) snap.partial = true;
    recordPRRawData(ghRepo, prNum, snap);
    return snap;
  })();
  prRawInflight.set(key, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    prRawInflight.delete(key);
  }
}

export function invalidatePRRawCache(ghRepo: string, prNum: number): void {
  prRawCache.delete(rawKey(ghRepo, prNum));
}

export function shouldPrefetchPRRawData(ghRepo: string, prNum: number, now = Date.now()): boolean {
  const key = rawKey(ghRepo, prNum);
  const cached = prRawCache.get(key);
  if (cached && now - cached.fetchedAt < PR_RAW_TTL_MS) return false;
  if (prRawInflight.has(key)) return false;
  return true;
}

// ─── GraphQL batch prefetch (ADR-028) ───
//
// `prList` would otherwise issue O(4·N) REST + O(1·N) GraphQL calls per refresh.
// `prefetchPRBatchViaGraphQL` issues one aliased GraphQL request per repo
// (chunked at 8 PRs/repo so large-PR queries actually seed), then
// synthesizes the same five `*Stdout` strings the per-PR REST path produces.
// Synthesized snapshots are written into `prRawCache` so the existing
// `getPRRawData` path becomes a cache-hit for every PR in the batch.
//
// Single-PR callers (`pr.status`, ci-monitor, dispatch, task-writer) keep the
// per-PR REST path — they aren't fan-outs and the 60s cache already covers them.
// On any GraphQL error the affected PRs simply aren't cached, so REST kicks
// back in naturally for them.

// 25-PR aliased queries with reviewThreads/checks regularly fail on large
// MetaMask PRs (live: mobile chunk of 25 never seeded). 8 stays under GitHub's
// query size and still collapses the per-PR GraphQL fallback.
const PR_BATCH_MAX_PER_REPO = 8;

interface BatchedRepoChunk {
  repo: string;
  owner: string;
  name: string;
  prs: number[];
}

// ─── GraphQL response shapes ───
// Narrow types for the slice of GitHub's GraphQL schema this file consumes.
// Optional everywhere — GitHub omits unknown fields and the synthesizer must
// degrade to empty stdout shapes rather than crash.

interface GqlAuthor {
  login?: string;
  __typename?: string;
}

interface GqlCheckRun {
  __typename: 'CheckRun';
  name?: string;
  conclusion?: string | null;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  detailsUrl?: string;
}

interface GqlStatusContext {
  __typename: 'StatusContext';
  context?: string;
  state?: string;
  createdAt?: string;
  targetUrl?: string;
}

type GqlCheckNode = GqlCheckRun | GqlStatusContext;

interface GqlIssueComment {
  databaseId?: number;
  author?: GqlAuthor;
  body?: string;
  createdAt?: string;
  url?: string;
}

interface GqlReviewComment {
  databaseId?: number;
  author?: GqlAuthor;
  body?: string;
  path?: string;
  line?: number | null;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  replyTo?: { databaseId?: number } | null;
}

interface GqlReviewThread {
  id?: string;
  path?: string;
  line?: number | null;
  isResolved?: boolean;
  isOutdated?: boolean;
  comments?: { nodes?: GqlReviewComment[] };
}

interface GqlCommitNode {
  commit?: { committedDate?: string };
}

interface GqlPageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
}

interface GqlPullRequestNode {
  author?: GqlAuthor | null;
  state?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  headRefName?: string;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string | null;
  mergedAt?: string | null;
  title?: string;
  statusCheckRollup?: { contexts?: { nodes?: GqlCheckNode[]; pageInfo?: GqlPageInfo } } | null;
  comments?: { nodes?: GqlIssueComment[] };
  reviewThreads?: { nodes?: GqlReviewThread[]; pageInfo?: GqlPageInfo };
  commits?: { nodes?: GqlCommitNode[] };
  latestOpinionatedReviews?: {
    nodes?: Array<{ author?: GqlAuthor | null; state?: string; submittedAt?: string | null }>;
  };
  reviewRequests?: {
    nodes?: Array<{
      requestedReviewer?: { __typename?: string; login?: string; slug?: string } | null;
    }>;
  };
}

interface GqlBatchResponse {
  data?: { repository?: Record<string, GqlPullRequestNode | null> | null };
  errors?: Array<{ message?: string }>;
}

export function chunkPRsByRepo(
  prsByRepo: Map<string, number[]>,
  maxPerRepo = PR_BATCH_MAX_PER_REPO,
): BatchedRepoChunk[] {
  const chunks: BatchedRepoChunk[] = [];
  for (const [repo, prs] of prsByRepo) {
    const parts = repo.split('/');
    if (parts.length !== 2) continue; // reject malformed slugs like 'a/b/c' or 'no-slash'
    const [owner, name] = parts;
    if (!owner || !name || prs.length === 0) continue;
    for (let i = 0; i < prs.length; i += maxPerRepo) {
      chunks.push({ repo, owner, name, prs: prs.slice(i, i + maxPerRepo) });
    }
  }
  return chunks;
}

function joinLinesOrEmpty(lines: string[]): string {
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

function fmtBatchErr(err: unknown, max = 200): string {
  return err instanceof Error ? err.message.slice(0, max) : String(err);
}

const EMPTY_PR_RAW_SNAPSHOT: PRRawSnapshot = {
  checksStdout: '',
  prStateStdout: '',
  commentsStdout: '',
  reviewCommentsStdout: '',
  latestCommitStdout: '',
  reviewMetaStdout: '',
  fetchedAt: 0,
};

// One aliased query per repo chunk. Aliases are `pr_<index>` so the response
// keys round-trip back to PR numbers via the `prs` array. No string-interpolated
// PR numbers — all values flow through `-F` integer variables, so there's no
// injection surface even though `owner`/`name` already come from trusted
// `project.json` config.
export function buildBatchQuery(prCount: number): string {
  const aliases: string[] = [];
  for (let i = 0; i < prCount; i++) {
    aliases.push(
      `    pr_${i}: pullRequest(number: $pr_${i}) {\n` +
        `      state mergeable mergeStateStatus reviewDecision headRefName createdAt updatedAt closedAt mergedAt title author { login }\n` +
        `      statusCheckRollup { contexts(first: 100) {\n` +
        `        pageInfo { hasNextPage }\n` +
        `        nodes {\n` +
        `          __typename\n` +
        `          ... on CheckRun { name conclusion status startedAt completedAt detailsUrl }\n` +
        `          ... on StatusContext { context state createdAt targetUrl }\n` +
        `      } } }\n` +
        `      comments(last: 50) { nodes {\n` +
        `        databaseId author { login __typename } body createdAt url\n` +
        `      } }\n` +
        `      reviewThreads(first: 100) {\n` +
        `        pageInfo { hasNextPage }\n` +
        `        nodes {\n` +
        `          isResolved isOutdated\n` +
        `          comments(first: 50) { nodes {\n` +
        `            databaseId author { login __typename } body path line createdAt url\n` +
        `            replyTo { databaseId }\n` +
        `        } } }\n` +
        `      }\n` +
        `      commits(last: 1) { nodes { commit { committedDate } } }\n` +
        `      latestOpinionatedReviews(first: 20) { nodes { author { login } state submittedAt } }\n` +
        `      reviewRequests(first: 20) { nodes { requestedReviewer {\n` +
        `        __typename ... on User { login } ... on Team { slug }\n` +
        `      } } }\n` +
        `    }`,
    );
  }
  const varDecls = Array.from({ length: prCount }, (_, i) => `$pr_${i}: Int!`).join(', ');
  return (
    `query($owner: String!, $name: String!, ${varDecls}) {\n` +
    `  repository(owner: $owner, name: $name) {\n` +
    `${aliases.join('\n')}\n` +
    `  }\n` +
    `}`
  );
}

// CheckRun.conclusion / .status → `gh pr checks --json bucket` value.
// Pending checks have no conclusion yet (status != COMPLETED).
function checkRunBucket(node: GqlCheckRun): string {
  if (node.status && node.status !== 'COMPLETED') return 'pending';
  switch (node.conclusion) {
    case 'SUCCESS':
      return 'pass';
    case 'FAILURE':
    case 'STARTUP_FAILURE':
    case 'TIMED_OUT':
    case 'ACTION_REQUIRED':
      return 'fail';
    case 'CANCELLED':
      return 'cancel';
    case 'NEUTRAL':
    case 'SKIPPED':
    case 'STALE':
      return 'skipping';
    default:
      return 'pending';
  }
}

// Legacy StatusContext (pre-CheckRun) state → bucket.
function statusContextBucket(node: GqlStatusContext): string {
  switch (node.state) {
    case 'SUCCESS':
      return 'pass';
    case 'FAILURE':
    case 'ERROR':
      return 'fail';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'pending';
  }
}

export function synthesizeRawSnapshotFromGraphQL(
  node: GqlPullRequestNode | null | undefined,
): PRRawSnapshot {
  // Defensive: callers like `runBatchChunk` already guard `if (!prNode) continue`,
  // but the function is exported and unit-tested independently — make the contract explicit.
  if (!node) return { ...EMPTY_PR_RAW_SNAPSHOT, fetchedAt: Date.now() };

  // checks: TSV `name<TAB>bucket<TAB>startedAt<TAB>completedAt` per line, no header.
  const checkNodes: GqlCheckNode[] = node.statusCheckRollup?.contexts?.nodes ?? [];
  const checksLines: string[] = [];
  for (const c of checkNodes) {
    if (c?.__typename === 'CheckRun') {
      checksLines.push(
        [
          c.name ?? '',
          checkRunBucket(c),
          c.startedAt ?? '',
          c.completedAt ?? '',
          c.conclusion ?? c.status ?? '',
          c.detailsUrl ?? '',
        ].join('\t'),
      );
    } else if (c?.__typename === 'StatusContext') {
      checksLines.push(
        [
          c.context ?? '',
          statusContextBucket(c),
          c.createdAt ?? '',
          '',
          c.state ?? '',
          c.targetUrl ?? '',
        ].join('\t'),
      );
    }
  }
  const checksStdout = joinLinesOrEmpty(checksLines);

  // prState: single TSV line `state\tmergeable\tmergeStateStatus\treviewDecision\theadRefName\tcreatedAt\tupdatedAt\tclosedAt\tmergedAt\ttitle`.
  // Title is last so embedded tabs in the title don't shift later fields (parser slices(9).join('\t')).
  const prStateStdout =
    [
      node.state ?? '',
      node.mergeable ?? '',
      node.mergeStateStatus ?? '',
      node.reviewDecision ?? '',
      node.headRefName ?? '',
      node.createdAt ?? '',
      node.updatedAt ?? '',
      node.closedAt ?? '',
      node.mergedAt ?? '',
      node.title ?? '',
    ].join('\t') + '\n';

  // commentsStdout: JSON-per-line, body truncated to 300 chars (matches jq `.body[0:300]`).
  // Bounded at the 50 most-recent issue comments by the GraphQL `comments(last: 50)`
  // slice (see buildBatchQuery). REST `repos/.../issues/N/comments --paginate` returns
  // every comment, so for a >50-comment PR the dashboard's batch path drops the OLDEST
  // issue comments. Acceptable because (a) matchBotComments only cares about live bot
  // posts, which sit near the tail not the head, and (b) the per-PR REST path used by
  // pr.status / ci-monitor still sees every comment. If a PR with >50 issue comments
  // ever has a load-bearing un-acknowledged bot post older than the most-recent 50,
  // the slot view (pr.status) still flags it.
  const commentNodes: GqlIssueComment[] = node.comments?.nodes ?? [];
  const commentsLines = commentNodes.map((c) =>
    JSON.stringify({
      id: c.databaseId,
      author: c.author?.login ?? '',
      user_type: c.author?.__typename ?? '',
      body: (c.body ?? '').slice(0, 300),
      created_at: c.createdAt ?? '',
      html_url: c.url ?? '',
    }),
  );
  const commentsStdout = joinLinesOrEmpty(commentsLines);

  // reviewCommentsStdout: JSON-per-line, only unresolved + non-outdated threads.
  // Author gets [bot] suffix when __typename === Bot to match REST `cursor[bot]` shape
  // — botPatterns regex (e.g. `cursor\[bot\]`) depend on this exact suffix.
  const threadNodes: GqlReviewThread[] = node.reviewThreads?.nodes ?? [];
  const reviewLines: string[] = [];
  for (const thread of threadNodes) {
    if (thread.isResolved === true || thread.isOutdated === true) continue;
    const tComments: GqlReviewComment[] = thread.comments?.nodes ?? [];
    for (const rc of tComments) {
      const isBot = rc.author?.__typename === 'Bot';
      const login = rc.author?.login ?? '';
      reviewLines.push(
        JSON.stringify({
          id: rc.databaseId,
          author: isBot ? `${login}[bot]` : login,
          user_type: rc.author?.__typename ?? '',
          body: (rc.body ?? '').slice(0, 300),
          path: rc.path ?? '',
          line: rc.line ?? null,
          created_at: rc.createdAt ?? '',
          in_reply_to_id: rc.replyTo?.databaseId ?? null,
          html_url: rc.url ?? '',
        }),
      );
    }
  }
  const reviewCommentsStdout = joinLinesOrEmpty(reviewLines);

  // latestCommitStdout: bare ISO date string, matches `gh api ... --jq '.[-1].commit.committer.date'`.
  // GraphQL `committedDate` is the same author/committer-side date REST returns.
  const commitNodes: GqlCommitNode[] = node.commits?.nodes ?? [];
  const lastDate = commitNodes[0]?.commit?.committedDate ?? '';
  const latestCommitStdout = lastDate ? lastDate + '\n' : '';

  // reviewMetaStdout: same JSON-per-line shape as the REST `--jq` projection.
  const reviewMetaLines: string[] = [];
  for (const review of node.latestOpinionatedReviews?.nodes ?? [])
    reviewMetaLines.push(
      JSON.stringify({
        t: 'review',
        author: review.author?.login ?? '',
        state: review.state ?? '',
        submittedAt: review.submittedAt ?? null,
      }),
    );
  for (const request of node.reviewRequests?.nodes ?? []) {
    const who = request.requestedReviewer;
    if (!who) continue;
    reviewMetaLines.push(
      JSON.stringify({
        t: 'request',
        kind: who.__typename === 'Team' ? 'team' : 'user',
        name: who.slug ?? who.login ?? '',
      }),
    );
  }
  const reviewMetaStdout = joinLinesOrEmpty(reviewMetaLines);

  return {
    author: node.author?.login || undefined,
    checksStdout,
    checksAvailable:
      (node.statusCheckRollup === null || Boolean(node.statusCheckRollup?.contexts?.nodes)) &&
      !isPRBatchTruncated(node),
    prStateStdout,
    commentsStdout,
    reviewCommentsStdout,
    latestCommitStdout,
    reviewMetaStdout,
    fetchedAt: Date.now(),
  };
}

// One GraphQL request per repo chunk. Quota holds fail the refresh; other failures log and continue —
// `prList` falls through to the per-PR REST path for whichever PRs aren't in cache.
// An 8-PR chunk with 100 contexts × 100 review threads × 50 comments could in
// principle produce a large response on monster PRs; github.rest handles the parse.
async function runBatchChunk(chunk: BatchedRepoChunk, seeded: Set<string>): Promise<void> {
  const query = buildBatchQuery(chunk.prs.length).replace(
    /}\s*$/,
    ' rateLimit { cost remaining resetAt } }',
  );
  const variables: Record<string, string | number> = { owner: chunk.owner, name: chunk.name };
  for (let i = 0; i < chunk.prs.length; i++) variables[`pr_${i}`] = chunk.prs[i];

  let parsed: GqlBatchResponse;
  try {
    parsed = await github.rest<GqlBatchResponse>('POST', 'graphql', {
      body: { query, variables },
      force: true,
    });
  } catch (err) {
    if (err instanceof GitHubQueryBudgetError) throw err;
    // Per-PR fallback engages — see function-level comment.
    console.warn(
      `[pr.batch] graphql_failed repo=${chunk.repo} prs=${chunk.prs.length} err=${fmtBatchErr(err)}`,
    );
    return;
  }

  const repoNode = parsed.data?.repository;
  if (!repoNode) return;

  for (let i = 0; i < chunk.prs.length; i++) {
    const prNum = chunk.prs[i];
    const prNode = repoNode[`pr_${i}`];
    if (!prNode) continue; // partial GraphQL error → REST fallback for this PR
    const truncated = isPRBatchTruncated(prNode);
    if (truncated) {
      console.warn(`[pr.batch] truncated repo=${chunk.repo} pr=${prNum} — seeding first page`);
    }
    const snap = synthesizeRawSnapshotFromGraphQL(prNode);
    if (truncated) snap.partial = true;
    recordPRRawData(chunk.repo, prNum, snap);
    // Complete pages can satisfy force/pr.status. Partial pages are list-only.
    if (!truncated) seeded.add(`${chunk.repo}#${prNum}`);
  }
}

export function isPRBatchTruncated(node: GqlPullRequestNode | null | undefined): boolean {
  if (!node) return false;
  if (node.statusCheckRollup?.contexts?.pageInfo?.hasNextPage === true) return true;
  if (node.reviewThreads?.pageInfo?.hasNextPage === true) return true;
  return false;
}

/** Returns the `repo#pr` keys whose raw snapshot this batch wrote; the rest need the per-PR path. */
export async function prefetchPRBatchViaGraphQL(
  prsByRepo: Map<string, number[]>,
): Promise<Set<string>> {
  const seeded = new Set<string>();
  if (prsByRepo.size === 0) return seeded;
  const retryAt = githubQueryBudget.anyReserved();
  if (retryAt) throw new GitHubQueryBudgetError(retryAt);
  const chunks = chunkPRsByRepo(prsByRepo);
  if (chunks.length === 0) return seeded;
  const totalPRs = chunks.reduce((sum, c) => sum + c.prs.length, 0);
  const startedAt = Date.now();
  await Promise.all(chunks.map((chunk) => runBatchChunk(chunk, seeded)));
  console.log(
    `[pr.batch] repos=${prsByRepo.size} prs=${totalPRs} chunks=${chunks.length} seeded=${seeded.size} duration_ms=${Date.now() - startedAt}`,
  );
  return seeded;
}

export type PRJsonLine = Record<string, string | number | boolean | null | undefined> & {
  id?: number;
  author?: string;
  user_type?: string;
  body?: string;
  html_url?: string;
  created_at?: string;
  path?: string;
  line?: number | null;
  in_reply_to_id?: number | null;
};

export function parseJsonLines(output: string): PRJsonLine[] {
  const results: PRJsonLine[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          results.push(parsed as PRJsonLine);
        }
      } catch {
        /* skip malformed GitHub JSONL fragments */
      }
    }
  }
  return results;
}
