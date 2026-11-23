import type { PRWorkflowDefaultSource } from './config.js';
import type { MonitoredPRIdentity, PRSourceAccount } from './pr-monitoring.js';

export interface ReviewPublicationPolicy {
  enabled: boolean;
  source: PRWorkflowDefaultSource | 'built-in';
  teamId: string;
  account: PRSourceAccount;
}

/** Best-effort GitHub display state; never publication or review authority. */
export interface ReviewViewedFilesResult {
  headSha: string;
  account?: PRSourceAccount;
  attemptedAt: string;
  state: 'complete' | 'partial' | 'skipped' | 'failed';
  paths: string[];
  markedPaths: string[];
  reason?: string;
}

export interface ReviewPublicationReceipt {
  version: 1;
  state: 'prepared' | 'posting' | 'published';
  runId: string;
  ownerId: string;
  ownerGeneration?: number;
  account: PRSourceAccount;
  pr: MonitoredPRIdentity;
  headSha: string;
  contentSha256: string;
  marker: string;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  attemptedAt: string;
  /** Hash of the outgoing body, retained for reconciliation after a lost response. */
  bodySha256?: string;
  reviewId?: number;
  url?: string;
  publishedAt?: string;
  viewedFiles?: ReviewViewedFilesResult;
}

/** Gateway-created authority for a direct static run, independent of PR-intake intent state. */
export interface DirectReviewPublication {
  ownerId: string;
  ownerGeneration?: number;
  pr: MonitoredPRIdentity;
  requested?: boolean;
  policy:
    | ReviewPublicationPolicy
    | {
        enabled: false;
        source: PRWorkflowDefaultSource | 'built-in';
        teamId?: never;
        account?: never;
      };
}

export function reviewPublicationPolicyForRun(
  run: Pick<import('./runs.js').Run, 'prWork' | 'reviewPublication'>,
) {
  return (
    run.reviewPublication?.gate?.publication.policy ??
    run.prWork?.publication ??
    run.reviewPublication?.direct?.policy
  );
}

/**
 * A finished review whose requested PR publication has neither a published receipt nor an
 * error yet. Until one lands the run is publishing, not done: posting by hand duplicates it.
 */
export function reviewPublicationPending(
  run: Pick<import('./runs.js').Run, 'status' | 'prWork' | 'reviewPublication'>,
): boolean {
  return (
    run.status === 'done' &&
    reviewPublicationPolicyForRun(run)?.enabled === true &&
    run.reviewPublication?.receipt?.state !== 'published' &&
    !run.reviewPublication?.error
  );
}
