import { createHash } from 'node:crypto';

import {
  type PRMonitorCheck,
  type PRMonitorConfig,
  type PRMonitorObservation,
  type PRMonitorSignal,
} from '@farmslot/protocol';

import {
  collectGitHubPages as pages,
  githubGraphQL as query,
  type GitHubPage as Page,
  type GitHubQueryAccount as Account,
} from '../integrations/github-graphql.js';

import { resolvePRSourceAccount } from './github-account.js';

interface Review {
  id: string;
  state: string;
  submittedAt: string | null;
  updatedAt: string;
  author: { login: string } | null;
  url: string;
}
interface Comment {
  id: string;
  body: string;
  updatedAt: string;
  url: string;
  author: { login: string; __typename: string } | null;
}
interface Thread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  comments: Page<Comment>;
}
interface Check {
  __typename: 'CheckRun' | 'StatusContext';
  id: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  detailsUrl?: string | null;
  targetUrl?: string | null;
}
interface PullRequest {
  id: string;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  author: { login: string } | null;
  headRefOid: string;
  baseRefOid: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  reviewDecision: string | null;
  url: string;
  headRefName: string;
  headRepository: { nameWithOwner: string; viewerPermission: string | null } | null;
}

const pageInfo = 'pageInfo { hasNextPage endCursor }';
const commentFields = 'id body updatedAt url author { login __typename }';

async function prConnection<T>(
  prId: string,
  field: string,
  fields: string,
  account: Account,
  pageSize = 100,
): Promise<T[]> {
  return pages(async (cursor) => {
    const data = await query<{ node: Record<string, Page<T>> }>(
      `query($id:ID!,$cursor:String) { node(id:$id) { ... on PullRequest { ${field}(first:${pageSize},after:$cursor) { ${pageInfo} nodes { ${fields} } } } } }`,
      { id: prId, cursor },
      account,
    );
    return data.node?.[field];
  });
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function fetchPRMonitorObservation(
  config: PRMonitorConfig,
  ownerId: string,
): Promise<PRMonitorObservation> {
  const account = await resolvePRSourceAccount(config.account, ownerId);
  const [owner, name] = config.pr.repo.split('/');
  const data = await query<{ repository: { pullRequest: PullRequest | null } | null }>(
    `query($owner:String!,$name:String!,$number:Int!) { repository(owner:$owner,name:$name) { pullRequest(number:$number) { id title state isDraft author { login } headRefOid baseRefOid headRefName headRepository { nameWithOwner viewerPermission } mergeable reviewDecision url } } }`,
    { owner, name, number: config.pr.number },
    account,
  );
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error('PR is unavailable to the selected GitHub account');
  if (!['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) || !pr.headRefOid || !pr.baseRefOid) {
    throw new Error('GitHub PR identity or state is incomplete');
  }
  const observation: PRMonitorObservation = {
    checkedAt: new Date().toISOString(),
    headSha: pr.headRefOid,
    title: pr.title,
    author: pr.author?.login ?? 'deleted-user',
    state: pr.state === 'OPEN' ? 'open' : pr.state === 'MERGED' ? 'merged' : 'closed',
    draft: pr.isDraft,
    mergeability:
      pr.mergeable === 'MERGEABLE'
        ? 'mergeable'
        : pr.mergeable === 'CONFLICTING'
          ? 'conflicting'
          : 'unknown',
    reviewDecision:
      pr.reviewDecision === 'APPROVED'
        ? 'approved'
        : pr.reviewDecision === 'CHANGES_REQUESTED'
          ? 'changes-requested'
          : pr.reviewDecision === 'REVIEW_REQUIRED'
            ? 'review-required'
            : 'unknown',
    signals: [],
    repairAccess: {
      allowed: Boolean(
        pr.headRepository &&
        pr.headRepository.nameWithOwner.toLowerCase() === config.pr.repo.toLowerCase() &&
        ['WRITE', 'MAINTAIN', 'ADMIN'].includes(pr.headRepository.viewerPermission ?? ''),
      ),
      ...(pr.headRepository ? { headRepository: pr.headRepository.nameWithOwner } : {}),
      ...(pr.headRefName ? { headBranch: pr.headRefName } : {}),
    },
  };
  if (!observation.repairAccess!.allowed)
    observation.repairAccess!.reason =
      pr.headRepository?.nameWithOwner.toLowerCase() !== config.pr.repo.toLowerCase()
        ? 'Repair requires a supported writable branch in the configured repository; this PR uses an external or unavailable head repository'
        : 'The selected GitHub account does not have branch write permission';
  if (observation.state !== 'open') return observation;

  const reviews = await prConnection<Review>(
    pr.id,
    'reviews',
    'id state submittedAt updatedAt author { login } url',
    account,
  );
  const latest = new Map<string, Review>();
  for (const review of reviews) {
    if (
      !review.author ||
      !review.submittedAt ||
      !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)
    )
      continue;
    const previous = latest.get(review.author.login);
    if (!previous || (previous.submittedAt ?? '') <= review.submittedAt)
      latest.set(review.author.login, review);
  }
  for (const review of latest.values()) {
    if (review.state === 'CHANGES_REQUESTED')
      observation.signals.push({
        kind: 'review',
        key: review.id,
        revision: review.updatedAt,
        summary: `${review.author?.login} requested changes`,
        url: review.url,
      });
  }

  const threads = await prConnection<Thread>(
    pr.id,
    'reviewThreads',
    `id isResolved isOutdated comments(first:10) { ${pageInfo} nodes { ${commentFields} } }`,
    account,
    20,
  );
  for (const thread of threads) {
    if (thread.isResolved || thread.isOutdated) continue;
    let firstPage = true;
    const comments = await pages<Comment>(async (cursor) => {
      if (firstPage) {
        firstPage = false;
        return thread.comments;
      }
      const result = await query<{ node: { comments: Page<Comment> } }>(
        `query($id:ID!,$cursor:String) { node(id:$id) { ... on PullRequestReviewThread { comments(first:100,after:$cursor) { ${pageInfo} nodes { ${commentFields} } } } } }`,
        { id: thread.id, cursor },
        account,
      );
      return result.node?.comments;
    });
    for (const comment of comments) {
      // Human inline feedback is actionable input. Bot policy is applied separately by project configuration.
      if (
        !comment.author ||
        comment.author.__typename === 'Bot' ||
        comment.author.login === pr.author?.login ||
        !comment.body.trim()
      )
        continue;
      observation.signals.push({
        kind: 'feedback',
        key: comment.id,
        revision: fingerprint(`${comment.updatedAt}:${comment.body}`),
        summary: `${comment.author.login}: ${comment.body.trim().slice(0, 180)}`,
        url: comment.url,
      });
    }
  }

  const checks = await pages<Check>(async (cursor) => {
    const result = await query<{
      node: {
        headRefOid: string;
        commits: { nodes: { commit: { statusCheckRollup: { contexts: Page<Check> } | null } }[] };
      };
    }>(
      `query($id:ID!,$cursor:String) { node(id:$id) { ... on PullRequest { headRefOid commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100,after:$cursor) { ${pageInfo} nodes { __typename ... on CheckRun { id name status conclusion startedAt completedAt detailsUrl } ... on StatusContext { id context state createdAt targetUrl } } } } } } } } } }`,
      { id: pr.id, cursor },
      account,
    );
    if (result.node?.headRefOid !== pr.headRefOid)
      throw new Error('PR head changed during observation; retry required');
    const commits = result.node.commits?.nodes;
    if (commits?.length !== 1) throw new Error('PR head checks are unavailable');
    return (
      commits[0].commit.statusCheckRollup?.contexts ?? {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }
    );
  });
  observation.checks = [];
  for (const check of checks) {
    const name = check.name ?? check.context;
    if (!name) throw new Error('GitHub returned a check without a name');
    const failure =
      check.__typename === 'CheckRun'
        ? check.status === 'COMPLETED' &&
          ['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(
            check.conclusion ?? '',
          )
        : ['FAILURE', 'ERROR'].includes(check.state ?? '');
    let status: PRMonitorCheck['status'] = 'unknown';
    if (failure) status = 'failed';
    else if (check.__typename === 'CheckRun') {
      if (['QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'PENDING'].includes(check.status ?? ''))
        status = 'pending';
      else if (check.conclusion === 'SUCCESS') status = 'passed';
      else if (check.conclusion === 'CANCELLED') status = 'cancelled';
      else if (check.conclusion === 'SKIPPED' || check.conclusion === 'NEUTRAL') status = 'skipped';
    } else if (check.state === 'SUCCESS') status = 'passed';
    else if (check.state === 'PENDING' || check.state === 'EXPECTED') status = 'pending';
    const url = check.detailsUrl || check.targetUrl || pr.url;
    observation.checks.push({ key: check.id, name, status, url });
    if (!failure || (config.watchedChecks.length && !config.watchedChecks.includes(name))) continue;
    const signal: PRMonitorSignal = {
      kind: 'check',
      key: check.id,
      revision: fingerprint(
        JSON.stringify([
          pr.headRefOid,
          check.startedAt,
          check.completedAt,
          check.createdAt,
          check.conclusion,
          check.state,
        ]),
      ),
      summary: `CI failed: ${name}`,
      checkName: name,
      url,
    };
    observation.signals.push(signal);
  }
  for (const name of config.watchedChecks) {
    if (!observation.checks.some((check) => check.name === name))
      observation.checks.push({
        key: `watched:${name}`,
        name,
        status: 'unknown',
        url: pr.url,
      });
  }
  if (observation.mergeability === 'conflicting')
    observation.signals.push({
      kind: 'conflict',
      key: 'merge-conflict',
      revision: `${pr.baseRefOid}:${pr.headRefOid}`,
      summary: 'PR conflicts with its base branch',
      url: pr.url,
    });
  observation.checkedAt = new Date().toISOString();
  return observation;
}
