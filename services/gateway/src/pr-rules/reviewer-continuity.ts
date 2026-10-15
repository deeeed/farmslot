import {
  DEFAULT_PR_REVIEW_OPTIONS,
  isPRWorkspaceExecutionChoice,
  type PRExecutionChoice,
  type PRReviewIntent,
  prReviewWorkflow,
  type Run,
} from '@farmslot/protocol';

import {
  compatibleWorkspaceReviewer,
  configureWorkspaceContinuity,
} from '../review-workspaces/continuity.js';
import {
  automatedRepeatReviewSelection,
  buildRepeatReviewContext,
  findLatestPriorReviewRun,
  incrementalReviewAvailable,
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
  const configured = source.review ?? DEFAULT_PR_REVIEW_OPTIONS;
  if (prReviewWorkflow(configured) === 'qa' || choices.every((choice) => choice.mode === 'cold'))
    return choices;
  const coldChoices = choices.filter((choice) => choice.mode === 'cold');
  const options = { ...configured, mode: 'warm' as const };
  if (!options.reviewContext?.reviewLineages.some((lineage) => lineage?.reviewId))
    return coldChoices;
  const identity = {
    id: `review:${intent.id}`,
    project,
    flowType: 'review-pr' as const,
    ticketOrPr: `${intent.pr.repo}#${intent.pr.number}`,
    reviewContext: options.reviewContext,
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
  if (!prior) return coldChoices;
  // Only picks a retained reviewer. The run's own context build confirms the
  // prior head is an ancestor before it settles on incremental scope.
  const previousContext = buildRepeatReviewContext(
    identity,
    prior,
    {
      project,
      repository: intent.pr.repo,
      prNumber: intent.pr.number,
      headSha: intent.headSha,
    },
    runs,
  );
  if (!incrementalReviewAvailable(previousContext)) return coldChoices;
  const context = automatedRepeatReviewSelection(previousContext, options);
  const retained = choices.filter((choice) => {
    if (choice.mode === 'cold') return true;
    if (isPRWorkspaceExecutionChoice(choice)) {
      const selected = structuredClone(context);
      const workspaceRun = {
        ...identity,
        reviewMode: options.mode,
        transport: choice.transport ?? 'tmux',
        nativeOwnerPrincipalId: source.ownerId,
        createdByPrincipalId: source.ownerId,
        reviewWorkspaceTarget: { machine: choice.machine },
        effort: choice.effort ?? undefined,
        metrics: { runner: choice.runner, model: choice.model },
      };
      if (!compatibleWorkspaceReviewer(workspaceRun, prior)) return false;
      configureWorkspaceContinuity(workspaceRun, prior, selected);
      return selected.session?.continuity === 'resumed';
    }
    return (
      resolveRepeatReviewResumePlan(
        {
          ...identity,
          slotId: choice.slotId,
          repeatReviewContext: context,
        },
        prior,
        choice.runner,
        choice.model,
        choice.effort,
      ).kind === 'resume'
    );
  });
  return retained;
}
