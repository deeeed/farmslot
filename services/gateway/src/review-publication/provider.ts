import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertMonitoredPRIdentity,
  type MonitoredPRIdentity,
  parseGitHubRef,
  type PRSourceAccount,
  type ReviewPublicationReceipt,
  type Run,
} from '@farmslot/protocol';

import { ghRequest } from '../integrations/github-client.js';
import { GitHubHttpError } from '../integrations/github-errors.js';
import { resolvePRSourceAccount } from '../pr-monitoring/github-account.js';

import { selectedReviewResult } from './selection.js';

export type { ReviewPublicationReceipt } from '@farmslot/protocol';

export interface PublishWorkspaceReviewInput {
  run: Run;
  ownerId: string;
  account: PRSourceAccount;
  pr: MonitoredPRIdentity;
  /** Re-check the current principal, project/account mapping and publication opt-in. */
  authorize: () => Promise<void>;
  /** Read and durably update the receipt before any provider mutation. */
  readReceipt: () => Promise<ReviewPublicationReceipt | undefined>;
  saveReceipt: (receipt: ReviewPublicationReceipt) => Promise<void>;
}

export class ReviewPublicationInProgressError extends Error {
  constructor() {
    super('Review publication is already in progress');
    this.name = 'ReviewPublicationInProgressError';
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const flights = new Map<string, Promise<ReviewPublicationReceipt>>();

/** One in-process flight per run; a durable attempted receipt prevents blind reposts after restart. */
export function publishWorkspaceReview(
  input: PublishWorkspaceReviewInput,
): Promise<ReviewPublicationReceipt> {
  if (flights.has(input.run.id)) throw new ReviewPublicationInProgressError();
  const flight = publishOnce(input).finally(() => flights.delete(input.run.id));
  flights.set(input.run.id, flight);
  return flight;
}

async function publishOnce(input: PublishWorkspaceReviewInput): Promise<ReviewPublicationReceipt> {
  const { run, pr, account, ownerId } = input;
  assertMonitoredPRIdentity(pr);
  if (pr.host !== 'github.com' || account.host.toLowerCase() !== pr.host)
    throw new Error('Review publication requires a matching supported GitHub account');
  if (run.flowType !== 'review-pr' || run.status !== 'done' || !run.reviewWorkspaceSubject)
    throw new Error('Only a completed workspace static review can be published');
  const owners = [
    run.createdByPrincipalId,
    run.nativeOwnerPrincipalId,
    run.prWork?.review?.ownerId,
  ].filter(Boolean);
  if (!owners.length || owners.some((owner) => owner !== ownerId))
    throw new Error('Review publication owner does not match the run');
  const ref = parseGitHubRef(run.ticketOrPr);
  if (!ref || ref.repo.toLowerCase() !== pr.repo.toLowerCase() || ref.number !== pr.number)
    throw new Error('Publication PR differs from the original review request');
  const subject = run.reviewWorkspaceSubject;
  const result = selectedReviewResult(run);
  if (
    !result?.reviewMd?.trim() ||
    ('stale' in result && result.stale === true) ||
    result.reviewSnapshot?.headSha !== subject.headSha ||
    subject.repository.toLowerCase() !== pr.repo.toLowerCase() ||
    (run.prWork &&
      (run.prWork.headSha !== subject.headSha ||
        run.prWork.pr.number !== pr.number ||
        run.prWork.pr.repo.toLowerCase() !== pr.repo.toLowerCase()))
  )
    throw new Error('Review result does not match its frozen PR source');
  if (!/^[a-f0-9]{40}$/.test(subject.headSha))
    throw new Error('Review head is not an exact commit');
  const recommendation = result.recommendation;
  if (!['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(recommendation))
    throw new Error('Review recommendation is unsupported');
  const comments = result.lineComments.map((comment) => {
    if (
      !comment.path ||
      !Number.isSafeInteger(comment.line) ||
      comment.line < 1 ||
      !comment.body.trim()
    )
      throw new Error('Review has an invalid inline finding');
    const labels: Record<string, string> = {
      blocker: 'Blocker',
      major: 'Major',
      minor: 'Minor',
      must_fix: 'Must fix',
      suggestion: 'Suggestion',
      nit: 'Nit',
    };
    const label = labels[comment.severity];
    return {
      path: comment.path,
      line: comment.line,
      side: 'RIGHT',
      body: label ? `**${label}.** ${comment.body}` : comment.body,
    };
  });
  const contentSha256 = createHash('sha256')
    .update(JSON.stringify([subject.headSha, recommendation, result.reviewMd, comments]))
    .digest('hex');
  const marker = `<!-- farmslot-review:${createHash('sha256')
    .update(
      JSON.stringify([run.id, ownerId, pr.host.toLowerCase(), pr.repo.toLowerCase(), pr.number]),
    )
    .digest('hex')} -->`;
  const publishedBody = `${result.reviewMd.trim()}\n\n${marker}`;
  await input.authorize();
  const binding = await resolvePRSourceAccount(account, ownerId);
  const endpoint = `repos/${pr.repo}/pulls/${pr.number}`;
  const get = async (suffix: string, extra: string[] = []) =>
    JSON.parse(
      (
        await ghRequest(
          ['api', '--hostname', pr.host, `${endpoint}${suffix}`, '--method', 'GET', ...extra],
          { account: binding, force: true },
        )
      ).stdout,
    );
  const prior = await input.readReceipt();
  if (
    prior &&
    (prior.runId !== run.id ||
      prior.ownerId !== ownerId ||
      prior.headSha !== subject.headSha ||
      prior.contentSha256 !== contentSha256 ||
      prior.marker !== marker ||
      prior.account.host.toLowerCase() !== account.host.toLowerCase() ||
      prior.account.login.toLowerCase() !== account.login.toLowerCase())
  )
    throw new Error('Publication receipt does not match the selected review/account');
  if (prior?.state === 'published') return prior;
  const pages = await get('/reviews?per_page=100', ['--paginate', '--slurp']);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
    throw new Error('GitHub review history is incomplete');
  const matches = pages
    .flat()
    .filter(
      (review: unknown): review is Record<string, unknown> =>
        record(review) && typeof review.body === 'string' && review.body.includes(marker),
    );
  if (matches.length > 1)
    throw new Error('Multiple provider reviews contain this publication marker');
  const retain = async (review: Record<string, unknown>, receipt: ReviewPublicationReceipt) => {
    if (
      typeof review.id !== 'number' ||
      !Number.isSafeInteger(review.id) ||
      review.id <= 0 ||
      review.commit_id !== subject.headSha ||
      !record(review.user) ||
      typeof review.user.login !== 'string' ||
      review.user.login.toLowerCase() !== account.login.toLowerCase() ||
      review.body !== publishedBody ||
      typeof review.submitted_at !== 'string' ||
      !Number.isFinite(Date.parse(review.submitted_at)) ||
      review.state !==
        { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[
          receipt.event
        ]
    )
      throw new Error('Provider receipt does not confirm the pinned review');
    const published: ReviewPublicationReceipt = {
      ...receipt,
      state: 'published',
      reviewId: review.id,
      url: typeof review.html_url === 'string' ? review.html_url : undefined,
      publishedAt: review.submitted_at,
    };
    await input.saveReceipt(published);
    return published;
  };
  if (matches.length) {
    if (!prior)
      throw new Error(
        'Provider review exists without a local attempted receipt; inspect publication history',
      );
    return retain(matches[0], prior);
  }
  if (prior && prior.state !== 'prepared')
    throw new Error(
      'Publication outcome is uncertain; no duplicate was sent. Retry reconciliation after checking GitHub.',
    );
  const live = await get('');
  if (
    live.number !== pr.number ||
    live.base?.repo?.full_name?.toLowerCase() !== pr.repo.toLowerCase() ||
    live.head?.sha !== subject.headSha ||
    live.state !== 'open'
  )
    throw new Error('PR is closed, unavailable or changed since the static review');
  const event =
    live.user?.login?.toLowerCase() === account.login.toLowerCase()
      ? 'COMMENT'
      : (recommendation as ReviewPublicationReceipt['event']);
  const receipt: ReviewPublicationReceipt = {
    version: 1,
    state: 'posting',
    runId: run.id,
    ownerId,
    account: structuredClone(account),
    pr: structuredClone(pr),
    headSha: subject.headSha,
    contentSha256,
    marker,
    event,
    attemptedAt: new Date().toISOString(),
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-publication-'));
  try {
    const file = path.join(directory, 'review.json');
    await writeFile(
      file,
      JSON.stringify({ commit_id: subject.headSha, event, body: publishedBody, comments }),
      { mode: 0o600 },
    );
    await input.authorize();
    await input.saveReceipt(receipt);
    try {
      await input.authorize();
    } catch (error) {
      // No provider mutation has been attempted; preserve a retryable reservation.
      await input.saveReceipt({ ...receipt, state: 'prepared' });
      throw error;
    }
    let response;
    try {
      response = await ghRequest(
        ['api', '--hostname', pr.host, `${endpoint}/reviews`, '--method', 'POST', '--input', file],
        { account: binding, force: true },
      );
    } catch (error) {
      // These explicit provider rejections confirm no review was created. Transport failures,
      // timeouts and server errors keep the uncertain receipt to prevent duplicate reviews.
      if (
        error instanceof GitHubHttpError &&
        [400, 401, 403, 404, 409, 422, 429].includes(error.status)
      ) {
        await input.saveReceipt({ ...receipt, state: 'prepared' });
      }
      throw error;
    }
    const posted: unknown = JSON.parse(response.stdout);
    if (!record(posted)) throw new Error('Provider returned an invalid review');
    return retain(posted, receipt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
