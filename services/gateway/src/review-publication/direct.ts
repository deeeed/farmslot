import {
  type DirectReviewPublication,
  parseGitHubRef,
  type ProjectConfig,
  type PRTeamProfile,
  resolvePRWorkflowDefaults,
  type RunCreateParams,
} from '@farmslot/protocol';

interface Authority {
  teams: (ownerId: string) => readonly PRTeamProfile[];
  authorize: (ownerId: string) => void;
}
let authority: Authority | undefined;
export function setDirectPublicationAuthority(value: Authority): void {
  authority = value;
}

type Request = Pick<
  RunCreateParams,
  'flowType' | 'reviewValidationDepth' | 'project' | 'ticketOrPr' | 'publishReview' | 'reviewTeamId'
>;

export function selectDirectReviewPublication(
  request: Request,
  project: ProjectConfig | null | undefined,
  ownerId: string,
  teams: readonly PRTeamProfile[],
): DirectReviewPublication | undefined {
  if (request.publishReview !== undefined && typeof request.publishReview !== 'boolean')
    throw new Error('publishReview must be boolean');
  if (request.flowType !== 'review-pr' || request.reviewValidationDepth === 'full-live') {
    if (request.publishReview === true || request.reviewTeamId)
      throw new Error('Publication requires static review-pr');
    return undefined;
  }
  const ref = parseGitHubRef(request.ticketOrPr);
  const base = resolvePRWorkflowDefaults({
    workflow: 'review-pr',
    farm: project?.workflowDefaults,
  });
  if (!ref) {
    if (request.publishReview === true || base.review.publishReview === true)
      throw new Error('Publication requires a canonical PR reference');
    return undefined;
  }
  const selection = (policy: DirectReviewPublication['policy']): DirectReviewPublication => ({
    ownerId,
    pr: { host: 'github.com', repo: ref.repo, number: ref.number },
    policy,
    ...(request.publishReview === undefined ? {} : { requested: request.publishReview }),
  });
  if (request.publishReview === false) return selection({ enabled: false, source: 'request' });
  const matches = teams.filter(
    (team) =>
      team.ownerId === ownerId &&
      team.config.account.host.toLowerCase() === 'github.com' &&
      team.config.repositories.some(
        (repo) =>
          repo.project === request.project && repo.repo.toLowerCase() === ref.repo.toLowerCase(),
      ),
  );
  const candidates = request.reviewTeamId
    ? matches.filter((team) => team.id === request.reviewTeamId)
    : matches;
  if (request.reviewTeamId && candidates.length !== 1)
    throw new Error('Selected PR team does not belong to this owner/project/repository');
  if (candidates.length > 1) {
    const configured =
      request.publishReview === true ||
      base.review.publishReview === true ||
      candidates.some(
        (team) =>
          team.config.review?.publishReview !== undefined ||
          team.config.repositories.some(
            (repo) =>
              repo.project === request.project &&
              repo.repo.toLowerCase() === ref.repo.toLowerCase() &&
              repo.review?.publishReview !== undefined,
          ),
      );
    if (configured)
      throw new Error('Several PR teams match; select --review-team for publication policy');
    return selection({ enabled: false, source: base.sources.publication ?? 'built-in' });
  }
  const team = candidates[0];
  const repository = team?.config.repositories.find(
    (repo) =>
      repo.project === request.project && repo.repo.toLowerCase() === ref.repo.toLowerCase(),
  );
  const resolved = resolvePRWorkflowDefaults({
    workflow: 'review-pr',
    request: {
      review: {
        sessionIntent: 'reset',
        scope: 'full',
        workflow: 'review',
        ...(request.publishReview === undefined ? {} : { publishReview: request.publishReview }),
      },
    },
    repository,
    team: team?.config,
    farm: project?.workflowDefaults,
  });
  const source = resolved.sources.publication ?? 'built-in';
  if (resolved.review.publishReview !== true) return selection({ enabled: false, source });
  if (!team)
    throw new Error('Publication needs an owned PR team mapped to this project/repository');
  return selection({
    enabled: true,
    source,
    teamId: team.id,
    account: structuredClone(team.config.account),
  });
}

export function captureDirectReviewPublication(
  request: Request,
  project: ProjectConfig | null | undefined,
  ownerId: string,
) {
  const selected = selectDirectReviewPublication(
    request,
    project,
    ownerId,
    authority?.teams(ownerId) ?? [],
  );
  if (selected?.policy.enabled) {
    if (!authority) throw new Error('PR publication authority is unavailable');
    authority.authorize(ownerId);
  }
  return selected;
}
