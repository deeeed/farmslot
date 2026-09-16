import type { PRWorkflowDefaultSource } from './config.js';
import type { MonitoredPRIdentity, PRSourceAccount } from './pr-monitoring.js';

export interface ReviewPublicationPolicy {
  enabled: boolean;
  source: PRWorkflowDefaultSource | 'built-in';
  teamId: string;
  account: PRSourceAccount;
}

export interface ReviewPublicationReceipt {
  version: 1;
  state: 'prepared' | 'posting' | 'published';
  runId: string;
  ownerId: string;
  account: PRSourceAccount;
  pr: MonitoredPRIdentity;
  headSha: string;
  contentSha256: string;
  marker: string;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  attemptedAt: string;
  reviewId?: number;
  url?: string;
  publishedAt?: string;
}

/** Gateway-created authority for a direct static run, independent of PR-intake intent state. */
export interface DirectReviewPublication {
  ownerId: string;
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
