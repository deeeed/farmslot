import { createHash } from 'node:crypto';

import {
  DEFAULT_PR_REVIEW_OPTIONS,
  intersectPRExecutionProfiles,
  monitoredPRKey,
  prReviewBlockedReason,
  type PRReviewContribution,
  type PRReviewIntent,
  prReviewPurpose,
  type PRRulePreviewItem,
} from '@farmslot/protocol';

export function reviewIntentId(item: PRRulePreviewItem, round = 1): string {
  const purpose = prReviewPurpose(item.review);
  return createHash('sha256')
    .update(
      JSON.stringify([
        monitoredPRKey(item.subject.pr),
        item.subject.headSha,
        item.reviewProfile,
        ...(purpose !== 'review' ? [purpose] : []),
        ...(round > 1 ? [round] : []),
      ]),
    )
    .digest('hex');
}

/** Legacy intents keep their durable id; compare their actual requested purpose. */
export function sameReviewPurpose(intent: PRReviewIntent, item: PRRulePreviewItem): boolean {
  const contributions = intent.contributions.filter((source) => source.eligible);
  const sources = contributions.length ? contributions : intent.contributions;
  return (
    sources.length > 0 &&
    sources.every((source) => prReviewPurpose(source.review) === prReviewPurpose(item.review))
  );
}

export function reviewSubjectRevision(item: PRRulePreviewItem): string {
  const facts = Object.entries(item.subject.facts).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256')
    .update(JSON.stringify([item.subject.headSha, facts]))
    .digest('hex');
}

export function updateReviewDisplay(intent: PRReviewIntent, item: PRRulePreviewItem): void {
  const author = item.subject.facts.author;
  intent.title = item.subject.title;
  intent.author =
    author?.state === 'known' && typeof author.value === 'string'
      ? author.value || undefined
      : undefined;
}

/** Retain the existing review eligibility policy for both validation depths. */
export function contributionBlockedReason(
  source: Pick<PRReviewContribution, 'reviewObservation'>,
): string | undefined {
  return prReviewBlockedReason(source.reviewObservation);
}

export function reconcileReviewIntent(intent: PRReviewIntent): void {
  if (intent.status === 'running' || intent.status === 'completed' || intent.status === 'failed')
    return;
  const contributors = intent.contributions.filter((item) => item.eligible);
  if (!contributors.length) {
    intent.status = 'withdrawn';
    intent.waitingReason = 'No enabled rule currently authorizes this review';
    return;
  }
  const unnecessary = contributors.map(contributionBlockedReason).find(Boolean);
  if (unnecessary) {
    intent.status = 'held';
    // This summary is shared across owners; account-specific details stay in filtered contributions.
    intent.waitingReason = 'Review is not needed for the current GitHub state.';
    return;
  }
  const projects = new Set(contributors.map((item) => item.project));
  if (contributors.some((item) => item.configurationErrors.length)) {
    intent.status = 'needs-configuration';
    intent.waitingReason = 'A matching rule requires configuration before this review can start';
    return;
  }
  if (
    projects.has(undefined) ||
    projects.size !== 1 ||
    contributors.some((item) => !item.execution)
  ) {
    intent.status = 'needs-configuration';
    intent.waitingReason =
      'Review requires a common project mapping and explicit slot/model configuration';
    return;
  }
  const profiles = contributors.flatMap((item) => (item.execution ? [item.execution] : []));
  if (!intersectPRExecutionProfiles(profiles).length) {
    intent.status = 'needs-configuration';
    intent.waitingReason = 'Matching rules have incompatible slot/model/effort constraints';
    return;
  }
  const reviewOptions = contributors.map((item) => item.review ?? DEFAULT_PR_REVIEW_OPTIONS);
  if (
    reviewOptions.some(
      (item) =>
        item.sessionIntent !== reviewOptions[0].sessionIntent ||
        item.scope !== reviewOptions[0].scope ||
        prReviewPurpose(item) !== prReviewPurpose(reviewOptions[0]) ||
        (item.busySession ?? 'wait') !== (reviewOptions[0].busySession ?? 'wait'),
    )
  ) {
    intent.status = 'needs-configuration';
    intent.waitingReason =
      'Matching rules have incompatible reviewer continuity or validation depth';
    return;
  }
  if (intent.status !== 'queued') {
    intent.status = 'held';
    intent.waitingReason = contributors.every(
      (item) => !item.deferredAt && (item.autoStart || item.acceptedAt),
    )
      ? 'Awaiting dispatch admission'
      : 'Awaiting operator acceptance';
  }
}

export function reviewIntentAuthorized(intent: PRReviewIntent): boolean {
  if (intent.dispatchHold) return false;
  const active = intent.contributions.filter((item) => item.eligible);
  return (
    active.length > 0 &&
    active.every(
      (item) =>
        !contributionBlockedReason(item) &&
        !item.configurationErrors.length &&
        !item.deferredAt &&
        (item.autoStart || Boolean(item.acceptedAt)),
    )
  );
}
