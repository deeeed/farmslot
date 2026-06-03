// methods/pr/raw-cache.ts — raw GitHub PR snapshot cache and GraphQL batch prefetch.

import type { CommandOutput } from '@farmslot/protocol';

import { ghRequest } from '../../integrations/github-client.js';

// ─── GitHub raw-response cache ───
// Shields the GitHub API from the 60s UI poll + ci-monitor tick. Keyed by
// `repo/pr`; cached snapshots hold the stdout of the five gh calls that drive
// PRStatus. Per-call overlays (slot/workerActive/summary/familyContext) are
// re-derived fresh from the run store on every PRStatus build, so cache reuse
// does not stale-read run-side signals.
//
// force=true bypasses both this cache and ghRequest's own ETag/neg cache —
// used by explicit refresh flows (ciWatch.poke, UI manual refresh).

export interface PRRawSnapshot {
  checksStdout: string;
  prStateStdout: string;
  commentsStdout: string;
  reviewCommentsStdout: string;
  latestCommitStdout: string;
  fetchedAt: number;
}

const PR_RAW_TTL_MS = 60 * 1000;
const prRawCache = new Map<string, PRRawSnapshot>();
const prRawInflight = new Map<string, Promise<PRRawSnapshot>>();

function swallowGh(label: string) {
  return (err: unknown): CommandOutput => {
    const message = err instanceof Error ? err.message : String(err);
    if (/rate limit|API rate limit exceeded|secondary rate limit/i.test(message)) {
      console.error(`[gh-rate-limit] ${label}: ${message.slice(0, 400)}`);
    }
    return { stdout: '', stderr: message };
  };
}

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
    'name,bucket,startedAt,completedAt',
    '--jq',
    '.[] | [.name, .bucket, (.startedAt // ""), (.completedAt // "")] | @tsv',
  ];
}

export async function getPRRawData(
  ghRepo: string,
  prNum: number,
  force?: boolean,
): Promise<PRRawSnapshot> {
  const key = `${ghRepo}#${prNum}`;
  if (!force) {
    const cached = prRawCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < PR_RAW_TTL_MS) return cached;
    const inflight = prRawInflight.get(key);
    if (inflight) return inflight;
  }
  const fetchPromise = (async (): Promise<PRRawSnapshot> => {
    const [checks, prState, comments, reviewComments, latestCommit] = await Promise.all([
      ghRequest(buildPRChecksArgs(prNum, ghRepo), { force }).catch(swallowGh(`pr.checks#${prNum}`)),
      ghRequest(
        [
          'pr',
          'view',
          String(prNum),
          '--repo',
          ghRepo,
          '--json',
          'state,mergeable,mergeStateStatus,title,reviewDecision,headRefName,createdAt,updatedAt,closedAt,mergedAt',
          '--jq',
          '[.state, .mergeable, .mergeStateStatus, .reviewDecision, .headRefName, (.createdAt // ""), (.updatedAt // ""), (.closedAt // ""), (.mergedAt // ""), .title] | @tsv',
        ],
        { force },
      ).catch(swallowGh(`pr.view#${prNum}`)),
      ghRequest(
        [
          'api',
          '--paginate',
          `repos/${ghRepo}/issues/${prNum}/comments`,
          '--jq',
          '.[] | {id: .id, author: .user.login, user_type: .user.type, body: .body[0:300], created_at: .created_at, html_url: .html_url}',
        ],
        { force },
      ).catch(swallowGh(`issues.comments#${prNum}`)),
      // Inline review comments via GraphQL — filters out resolved + outdated threads
      // server-side so ci-watch / pr-complete don't waste cycles re-triaging the same
      // findings the worker already addressed. REST `/pulls/N/comments` would return
      // every comment regardless of thread resolution state, defaulting to 30 per page.
      // `--paginate` walks the reviewThreads cursor so PRs with >100 threads (long
      // review cycles on example-browser PRs) don't regress to the same data-loss
      // mode this PR is fixing. Output shape matches the prior REST jq exactly so
      // downstream consumers (matchBotComments, task-writer.buildPRCompleteContext)
      // need no changes.
      (async () => {
        const [owner, name] = ghRepo.split('/');
        if (!owner || !name) return { stdout: '', stderr: '' };
        return ghRequest(
          [
            'api',
            'graphql',
            '--paginate',
            '-f',
            `query=query($owner: String!, $name: String!, $pr: Int!, $endCursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $pr) { reviewThreads(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { isResolved isOutdated comments(first: 50) { nodes { databaseId author { login __typename } body path line createdAt url replyTo { databaseId } } } } } } } }`,
            '-F',
            `owner=${owner}`,
            '-F',
            `name=${name}`,
            '-F',
            `pr=${prNum}`,
            // GraphQL author.login is the bare handle ("cursor"), REST returns "cursor[bot]".
            // Append [bot] suffix when __typename === Bot so existing botPatterns regex
            // (e.g. `cursor\[bot\]`) keep matching without a config sweep.
            // Note the doubled backslash before `(`: JS strips lone backslashes from
            // unknown escape sequences, so `'\('` becomes `'('`. We need jq to receive
            // a literal `\(...)` for its string interpolation, hence `'\\('`.
            '--jq',
            '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false and .isOutdated == false) | .comments.nodes[] | {id: .databaseId, author: (if .author.__typename == "Bot" then "\\(.author.login)[bot]" else .author.login end), user_type: .author.__typename, body: (.body[0:300] // ""), path: .path, line: .line, created_at: .createdAt, in_reply_to_id: .replyTo.databaseId, html_url: .url}',
          ],
          { force },
        );
      })().catch(swallowGh(`pulls.reviewThreads#${prNum}`)),
      ghRequest(
        ['api', `repos/${ghRepo}/pulls/${prNum}/commits`, '--jq', '.[-1].commit.committer.date'],
        { force },
      ).catch(swallowGh(`pulls.commits#${prNum}`)),
    ]);
    const snap: PRRawSnapshot = {
      checksStdout: checks.stdout,
      prStateStdout: prState.stdout,
      commentsStdout: comments.stdout,
      reviewCommentsStdout: reviewComments.stdout,
      latestCommitStdout: latestCommit.stdout,
      fetchedAt: Date.now(),
    };
    prRawCache.set(key, snap);
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
  prRawCache.delete(`${ghRepo}#${prNum}`);
}

export function shouldPrefetchPRRawData(ghRepo: string, prNum: number, now = Date.now()): boolean {
  const key = `${ghRepo}#${prNum}`;
  const cached = prRawCache.get(key);
  if (cached && now - cached.fetchedAt < PR_RAW_TTL_MS) return false;
  if (prRawInflight.has(key)) return false;
  return true;
}

// ─── GraphQL batch prefetch (ADR-028) ───
//
// `prList` would otherwise issue O(4·N) REST + O(1·N) GraphQL calls per refresh.
// `prefetchPRBatchViaGraphQL` issues one aliased GraphQL request per repo
// (chunked at 25 PRs/repo to stay under GraphQL's per-query cost cap), then
// synthesizes the same five `*Stdout` strings the per-PR REST path produces.
// Synthesized snapshots are written into `prRawCache` so the existing
// `getPRRawData` path becomes a cache-hit for every PR in the batch.
//
// Single-PR callers (`pr.status`, ci-monitor, dispatch, task-writer) keep the
// per-PR REST path — they aren't fan-outs and the 60s cache already covers them.
// On any GraphQL error the affected PRs simply aren't cached, so REST kicks
// back in naturally for them.

const PR_BATCH_MAX_PER_REPO = 25;

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
}

interface GqlStatusContext {
  __typename: 'StatusContext';
  context?: string;
  state?: string;
  createdAt?: string;
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
        `      state mergeable mergeStateStatus reviewDecision headRefName createdAt updatedAt closedAt mergedAt title\n` +
        `      statusCheckRollup { contexts(first: 100) {\n` +
        `        pageInfo { hasNextPage }\n` +
        `        nodes {\n` +
        `          __typename\n` +
        `          ... on CheckRun { name conclusion status startedAt completedAt }\n` +
        `          ... on StatusContext { context state createdAt }\n` +
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
        [c.name ?? '', checkRunBucket(c), c.startedAt ?? '', c.completedAt ?? ''].join('\t'),
      );
    } else if (c?.__typename === 'StatusContext') {
      checksLines.push([c.context ?? '', statusContextBucket(c), c.createdAt ?? '', ''].join('\t'));
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

  return {
    checksStdout,
    prStateStdout,
    commentsStdout,
    reviewCommentsStdout,
    latestCommitStdout,
    fetchedAt: Date.now(),
  };
}

// One GraphQL request per repo chunk. On any failure we log and continue —
// `prList` falls through to the per-PR REST path for whichever PRs aren't in cache.
// Relies on `ghRequest`'s 10MB stdout buffer; a 25-PR chunk with 100 contexts × 100
// review threads × 50 comments could in principle approach that ceiling on monster
// PRs. JSON.parse failure on truncation is caught below and falls back cleanly.
async function runBatchChunk(chunk: BatchedRepoChunk): Promise<void> {
  const query = buildBatchQuery(chunk.prs.length);
  const args = [
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-f',
    `owner=${chunk.owner}`,
    '-f',
    `name=${chunk.name}`,
  ];
  for (let i = 0; i < chunk.prs.length; i++) args.push('-F', `pr_${i}=${chunk.prs[i]}`);

  let stdout = '';
  try {
    const res = await ghRequest(args);
    stdout = res.stdout;
  } catch (err) {
    // REST fallback engages — see function-level comment.
    console.warn(
      `[pr.batch] graphql_failed repo=${chunk.repo} prs=${chunk.prs.length} err=${fmtBatchErr(err)}`,
    );
    return;
  }

  let parsed: GqlBatchResponse;
  try {
    parsed = JSON.parse(stdout) as GqlBatchResponse;
  } catch (err) {
    // REST fallback engages — see function-level comment.
    console.warn(`[pr.batch] graphql_parse_failed repo=${chunk.repo} err=${fmtBatchErr(err, 120)}`);
    return;
  }

  const repoNode = parsed.data?.repository;
  if (!repoNode) return;

  for (let i = 0; i < chunk.prs.length; i++) {
    const prNum = chunk.prs[i];
    const prNode = repoNode[`pr_${i}`];
    if (!prNode) continue; // partial GraphQL error → REST fallback for this PR
    // Truncation guard: a single GraphQL connection caps at first/last:100. If a PR
    // has more checks or review threads than that, the batch slice silently drops
    // the rest — and the REST/per-PR-paginated path used by pr.status sees them all.
    // Seeding a truncated snapshot as authoritative would hide late bot findings
    // (matchBotComments → actionableBotComments) and check failures past index 100.
    // Skip the cache seed for these PRs; getPRRawData falls back to the per-PR REST
    // path (which uses --paginate for review threads and --json for all checks).
    if (isPRBatchTruncated(prNode)) {
      console.warn(`[pr.batch] truncated repo=${chunk.repo} pr=${prNum} → REST fallback`);
      continue;
    }
    const snap = synthesizeRawSnapshotFromGraphQL(prNode);
    prRawCache.set(`${chunk.repo}#${prNum}`, snap);
  }
}

export function isPRBatchTruncated(node: GqlPullRequestNode | null | undefined): boolean {
  if (!node) return false;
  if (node.statusCheckRollup?.contexts?.pageInfo?.hasNextPage === true) return true;
  if (node.reviewThreads?.pageInfo?.hasNextPage === true) return true;
  return false;
}

export async function prefetchPRBatchViaGraphQL(prsByRepo: Map<string, number[]>): Promise<void> {
  if (prsByRepo.size === 0) return;
  const chunks = chunkPRsByRepo(prsByRepo);
  if (chunks.length === 0) return;
  const totalPRs = chunks.reduce((sum, c) => sum + c.prs.length, 0);
  const startedAt = Date.now();
  await Promise.all(chunks.map(runBatchChunk));
  console.log(
    `[pr.batch] repos=${prsByRepo.size} prs=${totalPRs} chunks=${chunks.length} duration_ms=${Date.now() - startedAt}`,
  );
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
