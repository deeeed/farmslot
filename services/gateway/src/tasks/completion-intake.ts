import { createHash } from 'node:crypto';

import {
  type AcceptanceCriterionRef,
  type AcceptanceDerivationSource,
  type DispatchInheritedAcceptance,
  isRecord,
  type PRCompletionIntakeIdentity,
  registeredAcceptanceCriteria,
  type Run,
} from '@farmslot/protocol';

import { ghRequest } from '../integrations/github-client.js';
import { getRunWithArchived } from '../runs/store.js';

export interface PRCompletionIntake {
  identity: PRCompletionIntakeIdentity;
  sources: AcceptanceDerivationSource[];
}

/** Why a pr-complete run's original criteria can't be read; the task writer refuses with it. */
export class PRCompletionCriteriaUnavailable extends Error {
  /** The parent run they were to come from; unset when the run's own ticket lacks them. */
  readonly parentRunId?: string;

  constructor(message: string, parentRunId?: string) {
    super(message);
    this.name = 'PRCompletionCriteriaUnavailable';
    this.parentRunId = parentRunId;
  }
}

type PRCompletionRun = Pick<
  Run,
  'acceptanceRegistration' | 'parentRunId' | 'project' | 'ticketData'
>;

/**
 * The criteria a pr-complete run is held to, with the parent run they come from when they are
 * inherited. Empty is an explicit registration; unavailable original obligations refuse.
 */
async function originalPRCompletionAcceptance(
  run: PRCompletionRun,
  getParent = getRunWithArchived,
): Promise<{ criteria: AcceptanceCriterionRef[]; fromRunId?: string }> {
  if (run.acceptanceRegistration) return { criteria: run.acceptanceRegistration.original };
  if (run.parentRunId) {
    const parent = await getParent(run.parentRunId);
    if (!parent || parent.project !== run.project)
      throw new PRCompletionCriteriaUnavailable(
        'PR completion: original parent acceptance registration is unavailable',
        run.parentRunId,
      );
    if (parent.ticketData && Array.isArray(parent.ticketData.acceptanceCriteria))
      return {
        criteria: registeredAcceptanceCriteria(
          parent.ticketData.acceptanceCriteria,
          parent.acceptanceRegistration,
        ),
        fromRunId: parent.id,
      };
    if (parent.ticketData)
      throw new PRCompletionCriteriaUnavailable(
        'PR completion: parent ticketData.acceptanceCriteria is unavailable',
        parent.id,
      );
  }
  if (!run.ticketData || !Array.isArray(run.ticketData.acceptanceCriteria))
    throw new PRCompletionCriteriaUnavailable(
      'PR completion: original ticket acceptance registration is unavailable',
    );
  return { criteria: registeredAcceptanceCriteria(run.ticketData.acceptanceCriteria) };
}

/** Empty is an explicit registration; unavailable original obligations refuse. */
export async function originalPRCompletionCriteria(
  run: PRCompletionRun,
  getParent = getRunWithArchived,
): Promise<AcceptanceCriterionRef[]> {
  return (await originalPRCompletionAcceptance(run, getParent)).criteria;
}

/**
 * What a pr-complete run following `parentRunId` inherits, for the dispatch preview: the parent's
 * original criteria, or why they can't be read (the task writer then refuses). Undefined when the
 * parent has no ticket: the writer then holds the run to its own ticket's criteria.
 */
export async function inheritedPRCompletionAcceptance(
  parentRunId: string,
  project: string,
  getParent = getRunWithArchived,
): Promise<DispatchInheritedAcceptance | undefined> {
  try {
    const { criteria, fromRunId } = await originalPRCompletionAcceptance(
      { parentRunId, project },
      getParent,
    );
    return fromRunId
      ? { fromRunId, criteria: criteria.map(({ id, text }) => ({ id, text })) }
      : undefined;
  } catch (error) {
    if (!(error instanceof PRCompletionCriteriaUnavailable)) throw error;
    return error.parentRunId
      ? { fromRunId: error.parentRunId, criteria: [], unavailable: error.message }
      : undefined;
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`PR completion intake: missing ${field}`);
  return value;
}

function records(stdout: string): Record<string, unknown>[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) throw new Error('PR completion intake: invalid provider response');
      return value;
    });
}

export function completionCommentSource(
  repository: string,
  prNumber: number,
  kind: 'issue' | 'review' | 'thread',
  row: Record<string, unknown>,
  resolved = false,
): AcceptanceDerivationSource {
  const id = row.id;
  if ((typeof id !== 'number' && typeof id !== 'string') || !String(id))
    throw new Error('PR completion intake: comment has no provider identity');
  const body = text(row.body, 'comment.body');
  const updatedAt = text(row.updatedAt, 'comment.updatedAt');
  return {
    id: `github:${repository}#${prNumber}:${kind}:${id}`,
    kind: 'review-comment',
    body,
    version: createHash('sha256').update(JSON.stringify({ body, updatedAt })).digest('hex'),
    url: text(row.url, 'comment.url'),
    ...(row.author === null || row.author === undefined
      ? {}
      : { author: text(row.author, 'comment.author') }),
    providerKind: kind,
    ...(kind === 'review' ? { reviewId: String(id) } : { commentId: String(id) }),
    updatedAt,
    ...(typeof row.threadId === 'string' ? { threadId: row.threadId } : {}),
    ...(typeof row.databaseId === 'number'
      ? { databaseId: row.databaseId }
      : typeof id === 'number'
        ? { databaseId: id }
        : {}),
    ...(typeof row.path === 'string' ? { path: row.path } : {}),
    ...(typeof row.line === 'number' ? { line: row.line } : {}),
    resolved,
  };
}

/** One complete, full-body provider snapshot for every PR-completion entry point. */
export async function fetchPRCompletionIntake(
  repository: string,
  prNumber: number,
  request = ghRequest,
): Promise<PRCompletionIntake> {
  const [owner, name, extra] = repository.split('/');
  if (!owner || !name || extra || !Number.isSafeInteger(prNumber) || prNumber < 1)
    throw new Error('PR completion intake: invalid PR identity');
  const query = `query($owner:String!,$name:String!,$pr:Int!,$endCursor:String){
    repository(owner:$owner,name:$name){pullRequest(number:$pr){headRefOid
      reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{
        id isResolved comments(first:100){pageInfo{hasNextPage} nodes{
          id databaseId body path line updatedAt url author{login}
        }}
      }}
    }}
  }`;
  const [threads, issues, reviews] = await Promise.all([
    request(
      [
        'api',
        'graphql',
        '--paginate',
        '-f',
        `query=${query}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-F',
        `pr=${prNumber}`,
        '--jq',
        '.data.repository.pullRequest | @json',
      ],
      { force: true, caller: 'pr-complete:acceptance-intake' },
    ),
    request(
      [
        'api',
        '--paginate',
        `repos/${repository}/issues/${prNumber}/comments`,
        '--jq',
        '.[] | {id,body,updatedAt:.updated_at,url:.html_url,author:.user.login} | @json',
      ],
      { force: true, caller: 'pr-complete:acceptance-intake' },
    ),
    request(
      [
        'api',
        '--paginate',
        `repos/${repository}/pulls/${prNumber}/reviews`,
        '--jq',
        '.[] | {id,body,state,updatedAt:.submitted_at,url:.html_url,author:.user.login} | @json',
      ],
      { force: true, caller: 'pr-complete:acceptance-intake' },
    ),
  ]);
  const sources: AcceptanceDerivationSource[] = [];
  let headSha: string | undefined;
  const pages = records(threads.stdout);
  if (!pages.length) throw new Error('PR completion intake: provider returned no PR snapshot');
  for (const page of pages) {
    const head = text(page.headRefOid, 'PR head');
    if (!/^[a-f0-9]{40}$/i.test(head) || (headSha && headSha !== head))
      throw new Error('PR completion intake: PR head changed during capture');
    headSha = head;
    const connection = page.reviewThreads;
    if (!isRecord(connection) || !Array.isArray(connection.nodes))
      throw new Error('PR completion intake: incomplete review-thread connection');
    for (const thread of connection.nodes) {
      if (!isRecord(thread) || typeof thread.isResolved !== 'boolean' || !isRecord(thread.comments))
        throw new Error('PR completion intake: incomplete review thread');
      const comments = thread.comments;
      if (
        !isRecord(comments.pageInfo) ||
        comments.pageInfo.hasNextPage !== false ||
        !Array.isArray(comments.nodes)
      )
        throw new Error(
          `PR completion intake: incomplete comment connection in thread ${String(thread.id)}`,
        );
      for (const comment of comments.nodes) {
        if (
          !isRecord(comment) ||
          (comment.author !== null && comment.author !== undefined && !isRecord(comment.author))
        )
          throw new Error('PR completion intake: incomplete review comment');
        sources.push(
          completionCommentSource(
            repository,
            prNumber,
            'thread',
            {
              ...comment,
              threadId: text(thread.id, 'thread.id'),
              author: isRecord(comment.author) ? comment.author.login : undefined,
            },
            thread.isResolved,
          ),
        );
      }
    }
  }
  for (const [kind, response] of [
    ['issue', issues],
    ['review', reviews],
  ] as const)
    for (const row of records(response.stdout)) {
      // An unsubmitted draft is not a published obligation and has no submitted_at.
      if (kind === 'review' && row.state === 'PENDING') continue;
      sources.push(completionCommentSource(repository, prNumber, kind, row));
    }
  if (!headSha) throw new Error('PR completion intake: missing captured head');
  return {
    identity: {
      provider: 'github',
      repository,
      prNumber,
      headSha,
      capturedAt: new Date().toISOString(),
    },
    sources,
  };
}
