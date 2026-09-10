import {
  DEFAULT_PR_REVIEW_OPTIONS,
  type PRExecutionChoice,
  type PRReviewIntent,
  type Run,
} from '@farmslot/protocol';

import {
  automatedRepeatReviewSelection,
  buildRepeatReviewContext,
  findLatestPriorReviewRun,
} from '../run-engine/engine-decisions.js';
import { resolveRepeatReviewResumePlan } from '../run-engine/review-session-chain.js';

/** Saved sessions do not reserve slots; each new round resolves its authorized pool again. */
export function preferRetainedReviewer(
  intent: PRReviewIntent,
  project: string,
  choices: PRExecutionChoice[],
  runs: Run[],
): PRExecutionChoice[] {
  const source = intent.contributions.find((item) => item.eligible);
  if (!source) return [];
  const options = source.review ?? DEFAULT_PR_REVIEW_OPTIONS;
  if (options.sessionIntent !== 'resume' || options.scope !== 'incremental') return choices;
  const identity = {
    id: `review:${intent.id}`,
    project,
    flowType: 'review-pr' as const,
    ticketOrPr: `${intent.pr.repo}#${intent.pr.number}`,
    prWork: {
      kind: 'review' as const,
      id: `review:${intent.id}`,
      sourceId: intent.id,
      pr: intent.pr,
      headSha: intent.headSha,
      review: { profile: intent.reviewProfile, ownerId: source.ownerId, options },
    },
  };
  const prior = findLatestPriorReviewRun(identity, runs);
  if (!prior) return choices;
  const context = automatedRepeatReviewSelection(
    buildRepeatReviewContext(
      identity,
      prior,
      {
        project,
        repository: intent.pr.repo,
        prNumber: intent.pr.number,
        headSha: intent.headSha,
      },
      runs,
    ),
    options,
  );
  const retained = choices.filter(
    (choice) =>
      resolveRepeatReviewResumePlan(
        {
          ...identity,
          slotId: choice.slotId,
          repeatReviewContext: context,
        },
        prior,
        choice.runner,
        choice.model,
      ).kind === 'resume',
  );
  if (!retained.length) return choices;
  if (options.busySession !== 'fresh') return retained;
  return [...retained, ...choices.filter((choice) => !retained.includes(choice))];
}
