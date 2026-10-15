import {
  type PRReviewContribution,
  type PRReviewIntent,
  prReviewWorkflow,
  type PRTeamProfile,
  type ReviewPublicationPolicy,
} from '@farmslot/protocol';

import type { PRRuleStore } from './store.js';

/** Capture account and policy origin with the same contribution used for execution. */
export function publicationForIntent(
  intent: PRReviewIntent,
  store: PRRuleStore,
): ReviewPublicationPolicy | undefined {
  const source = intent.contributions.find((entry) => entry.eligible);
  if (source?.review?.publishReview === undefined || prReviewWorkflow(source.review) !== 'review')
    return undefined;
  const team = store.team(source.teamId, source.ownerId);
  return {
    enabled: source.review.publishReview,
    source: source.policySources?.publication ?? 'built-in',
    teamId: source.teamId,
    account: structuredClone(team.config.account),
  };
}

/** Publication authority cannot be inherited from another request sharing execution. */
export function samePublicationAuthority(
  left: Pick<PRReviewContribution, 'ownerId' | 'teamId'>,
  right: Pick<PRReviewContribution, 'ownerId' | 'teamId'>,
  teams: readonly PRTeamProfile[],
): boolean {
  if (left.ownerId !== right.ownerId) return false;
  const account = (source: typeof left) =>
    teams.find((team) => team.id === source.teamId && team.ownerId === source.ownerId)?.config
      .account;
  const a = account(left),
    b = account(right);
  return (
    !!a &&
    !!b &&
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.login.toLowerCase() === b.login.toLowerCase()
  );
}

export function hasPublicationAuthorityConflict(
  intent: PRReviewIntent,
  teams: readonly PRTeamProfile[],
): boolean {
  const sources = intent.contributions.filter(
    (source) => source.eligible && source.review?.publishReview === true,
  );
  return sources.some((source) => !samePublicationAuthority(source, sources[0], teams));
}
