import {
  type MonitoredPRIdentity,
  monitoredPRKey,
  type PRRuleField,
  prRuleFieldKey,
  type PRRulePredicate,
  type PRRuleSubject,
  type PRTeamProfile,
  type PRTriggerRule,
} from '@farmslot/protocol';

import { githubRequestCacheKey } from '../integrations/github-client.js';
import {
  collectGitHubPages as pages,
  githubGraphQL as query,
  type GitHubPage as Page,
  type GitHubQueryAccount as Account,
} from '../integrations/github-graphql.js';
import { githubQueryBudget } from '../integrations/github-query-budget.js';
import { resolvePRSourceAccount } from '../pr-monitoring/github-account.js';

import {
  GITHUB_PROJECT_FIELD,
  GITHUB_PROJECT_VALUE_FIELDS,
  GITHUB_RULE_PAGE_INFO as pageInfo,
  GITHUB_RULE_PR_FIELDS,
  type GitHubProjectField,
  type GitHubProjectItem,
  type GitHubProjectValue,
  type GitHubRulePR,
} from './github-source-types.js';
import type { PRSourceScan } from './preview.js';
import {
  matchPRSourceScopes,
  projectBindingErrors,
  sourcePredicates,
  unresolvedSourceFilters,
} from './project-scope.js';
import {
  PRSourceCheckpoints,
  prSourceCheckpointScope,
  PRSourceTraversal,
} from './source-checkpoints.js';

function requiredFields(predicate: PRRulePredicate): PRRuleField[] {
  if (predicate.kind === 'compare') return [predicate.field];
  if (predicate.kind === 'not') return requiredFields(predicate.item);
  return predicate.items.flatMap(requiredFields);
}

const projectItemFields = `id isArchived content { __typename ... on PullRequest { ${GITHUB_RULE_PR_FIELDS} } } fieldValues(first:100) { ${pageInfo} nodes { ${GITHUB_PROJECT_VALUE_FIELDS} } }`;
const repositoryKey = (repo: string) => JSON.stringify(['repository', repo.toLowerCase()]);
const connectionKey = (
  id: string,
  type: string,
  field: string,
  fields: string,
  head?: string,
  base?: string,
) => JSON.stringify([type, id, field, fields, head, base]);
function readPages<T>(
  traversal: PRSourceTraversal | undefined,
  key: string,
  fetch: (cursor: string | null) => Promise<Page<T>>,
  dependencies: string[] = [],
): Promise<T[]> {
  return traversal ? traversal.pages(key, fetch, dependencies) : pages(fetch);
}

async function repositoryPRs(
  repo: string,
  account: Account,
  traversal?: PRSourceTraversal,
): Promise<GitHubRulePR[]> {
  const [owner, name] = repo.split('/');
  return readPages(traversal, repositoryKey(repo), async (cursor) => {
    const data = await query<{ repository: { pullRequests: Page<GitHubRulePR> } }>(
      `query($owner:String!,$name:String!,$cursor:String) { repository(owner:$owner,name:$name) { pullRequests(first:100,after:$cursor,states:OPEN) { ${pageInfo} nodes { ${GITHUB_RULE_PR_FIELDS} } } } }`,
      { owner, name, cursor },
      account,
    );
    return data.repository?.pullRequests;
  });
}

async function connection<T>(
  id: string,
  type: string,
  field: string,
  fields: string,
  account: Account,
  options: {
    expectedHead?: string;
    expectedBase?: string;
    traversal?: PRSourceTraversal;
    dependencies?: string[];
  } = {},
): Promise<T[]> {
  const { expectedHead, expectedBase, traversal, dependencies = [] } = options;
  const key = connectionKey(id, type, field, fields, expectedHead, expectedBase);
  return readPages(
    traversal,
    key,
    async (cursor) => {
      const data = await query<{ node: (Record<string, Page<T>> & Partial<GitHubRulePR>) | null }>(
        `query($id:ID!,$cursor:String) { node(id:$id) { ... on ${type} { ${expectedHead ? GITHUB_RULE_PR_FIELDS : ''} ${field}(first:100,after:$cursor${field === 'projectItems' ? ',includeArchived:true' : ''}) { ${pageInfo} nodes { ${fields} } } } } }`,
        { id, cursor },
        account,
      );
      if (
        expectedHead &&
        (data.node?.headRefOid !== expectedHead ||
          (expectedBase && data.node?.baseRefOid !== expectedBase))
      ) {
        if (traversal) {
          if (data.node?.id && data.node.headRefOid) {
            const { [field]: _connection, ...parent } = data.node;
            await traversal.refreshPR(
              { ...parent, id: data.node.id, headRefOid: data.node.headRefOid },
              [key],
            );
          } else await traversal.invalidate(dependencies.length ? dependencies : [key]);
        }
        throw new Error(
          'PR head changed while collecting head-dependent facts; refresh before using this observation',
        );
      }
      return data.node?.[field] as Page<T>;
    },
    dependencies,
  );
}

export async function collectPRRuleSources(
  team: PRTeamProfile,
  rule: PRTriggerRule,
  checkpoints?: PRSourceCheckpoints,
  requestLimit = 25,
): Promise<PRSourceScan> {
  if (!checkpoints) return collectPRSubjects(team, rule.config.predicate);
  const account = await resolvePRSourceAccount(team.config.account, team.ownerId);
  const result = await checkpoints.read(
    prSourceCheckpointScope(team, rule, account),
    requestLimit,
    (traversal) =>
      collectPRSubjects(team, rule.config.predicate, undefined, false, { account, traversal }),
  );
  if (!result.complete && (result.progress.pendingConnections || result.progress.nextAttemptAt)) {
    result.progress.nextAttemptAt =
      githubQueryBudget.nextEligibleAt(
        githubRequestCacheKey([], { ...account, scope: 'query-budget' }),
      ) ?? new Date(Date.now() + 30_000).toISOString();
  }
  return result;
}

export async function collectPRRuleTarget(
  team: PRTeamProfile,
  rule: PRTriggerRule,
  pr: MonitoredPRIdentity,
): Promise<PRSourceScan> {
  return collectPRSubjects(team, rule.config.predicate, pr, true);
}

export async function collectPRSubmissionSources(
  team: PRTeamProfile,
  pr: MonitoredPRIdentity,
): Promise<PRSourceScan> {
  return collectPRSubjects(team, { kind: 'all', items: [] }, pr);
}

async function collectPRSubjects(
  team: PRTeamProfile,
  predicate: PRRulePredicate,
  onlyPR?: MonitoredPRIdentity,
  requireSourceScope = false,
  checkpoint?: { account: Account; traversal: PRSourceTraversal },
): Promise<PRSourceScan> {
  if (!onlyPR || requireSourceScope) {
    const errors = team.config.sources.flatMap(unresolvedSourceFilters);
    if (errors.length) return { subjects: [], complete: false, errors, ignoredItems: 0 };
  }
  const account =
    checkpoint?.account ?? (await resolvePRSourceAccount(team.config.account, team.ownerId));
  const traversal = checkpoint?.traversal;
  const roots = team.config.sources.flatMap((source) =>
    source.kind === 'repository'
      ? [repositoryKey(source.repo)]
      : [
          connectionKey(source.projectId, 'ProjectV2', 'fields', GITHUB_PROJECT_FIELD),
          connectionKey(source.projectId, 'ProjectV2', 'items', projectItemFields),
        ],
  );
  const errors: string[] = [];
  const candidates = new Map<string, GitHubRulePR>();
  const origins = new Map<string, Set<number>>();
  const addCandidate = (pr: GitHubRulePR, sourceIndex: number) => {
    if (!onlyPR || !candidates.has(pr.id)) candidates.set(pr.id, pr);
    const memberships = origins.get(pr.id) ?? new Set<number>();
    memberships.add(sourceIndex);
    origins.set(pr.id, memberships);
  };
  const projectItems = new Map<string, Map<string, GitHubProjectItem>>();
  const projectFields = new Map<string, GitHubProjectField[]>();
  const predicates = [
    team.config.predicate,
    predicate,
    ...(!onlyPR || requireSourceScope ? team.config.sources.flatMap(sourcePredicates) : []),
  ];
  const needed = predicates.flatMap(requiredFields);
  const failedProjects = new Set<string>();
  let ignoredItems = 0;
  if (onlyPR) {
    const [owner, name] = onlyPR.repo.split('/');
    const data = await query<{ repository: { pullRequest: GitHubRulePR | null } | null }>(
      `query($owner:String!,$name:String!,$number:Int!) { repository(owner:$owner,name:$name) { pullRequest(number:$number) { ${GITHUB_RULE_PR_FIELDS} } } }`,
      { owner, name, number: onlyPR.number },
      account,
    );
    if (!data.repository?.pullRequest)
      throw new Error('Requested PR is unavailable to the team account');
    candidates.set(data.repository.pullRequest.id, data.repository.pullRequest);
  }
  const targetPR = onlyPR ? [...candidates.values()][0] : undefined;
  const needsTargetProjects =
    !!targetPR &&
    team.config.sources.some((source) => source.kind === 'github-project') &&
    (requireSourceScope ||
      needed.some((field) => typeof field !== 'string' || field === 'project-memberships'));
  const targetProjects = needsTargetProjects
    ? await connection<GitHubProjectItem & { project: { id: string } }>(
        targetPR!.id,
        'PullRequest',
        'projectItems',
        `id isArchived project { id } fieldValues(first:100) { ${pageInfo} nodes { ${GITHUB_PROJECT_VALUE_FIELDS} } }`,
        account,
      )
    : [];
  for (const [sourceIndex, source] of team.config.sources.entries()) {
    if (onlyPR && source.kind === 'repository') {
      if (targetPR && source.repo.toLowerCase() === onlyPR.repo.toLowerCase())
        addCandidate(targetPR, sourceIndex);
      continue;
    }
    if (onlyPR && !needsTargetProjects) continue;
    try {
      if (source.kind === 'repository') {
        for (const pr of await repositoryPRs(source.repo, account, traversal))
          addCandidate(pr, sourceIndex);
      } else {
        if (failedProjects.has(source.projectId)) continue;
        const cached = projectItems.get(source.projectId);
        if (cached) {
          for (const item of cached.values())
            if (item.content?.__typename === 'PullRequest') addCandidate(item.content, sourceIndex);
          continue;
        }
        const fields = await connection<GitHubProjectField>(
          source.projectId,
          'ProjectV2',
          'fields',
          GITHUB_PROJECT_FIELD,
          account,
          { traversal },
        );
        const items = targetPR
          ? targetProjects
              .filter((item) => item.project.id === source.projectId)
              .map((item) => ({ ...item, content: { ...targetPR, __typename: 'PullRequest' } }))
          : await connection<GitHubProjectItem>(
              source.projectId,
              'ProjectV2',
              'items',
              projectItemFields,
              account,
              {
                traversal,
                dependencies: [
                  connectionKey(source.projectId, 'ProjectV2', 'fields', GITHUB_PROJECT_FIELD),
                ],
              },
            );
        projectFields.set(source.projectId, fields);
        const byPR = new Map<string, GitHubProjectItem>();
        for (const item of items) {
          if (typeof item.isArchived !== 'boolean')
            throw new Error('Project item archive state is unavailable');
          if (item.isArchived) {
            ignoredItems += 1;
            continue;
          }
          if (!item.content || item.content.__typename !== 'PullRequest') {
            ignoredItems += 1;
            continue;
          }
          addCandidate(item.content, sourceIndex);
          byPR.set(item.content.id, item);
        }
        projectItems.set(source.projectId, byPR);
      }
    } catch (error) {
      if (source.kind === 'github-project') failedProjects.add(source.projectId);
      // Partial source discovery is reported explicitly and cannot authorize admission or withdrawals.
      errors.push(
        `${source.kind === 'repository' ? source.repo : source.label}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (traversal?.exhausted) break;
    }
  }
  errors.push(...projectBindingErrors(predicates, projectFields));
  const memberships = new Map<string, Set<string>>();
  if (needed.includes('author-teams')) {
    for (const configured of team.config.githubTeams) {
      const [org, slug] = configured.split('/');
      try {
        const members = await readPages<{ login: string }>(
          traversal,
          JSON.stringify(['githubTeam', configured]),
          async (cursor) => {
            const data = await query<{
              organization: { team: { members: Page<{ login: string }> } };
            }>(
              `query($org:String!,$slug:String!,$cursor:String) { organization(login:$org) { team(slug:$slug) { members(first:100,after:$cursor) { ${pageInfo} nodes { login } } } } }`,
              { org, slug, cursor },
              account,
            );
            return data.organization?.team?.members;
          },
        );
        memberships.set(configured, new Set(members.map((member) => member.login.toLowerCase())));
      } catch (error) {
        errors.push(`${configured}: ${error instanceof Error ? error.message : String(error)}`);
        if (traversal?.exhausted) break;
      }
    }
  }
  const subjects: PRRuleSubject[] = [];
  for (const field of needed) {
    if (typeof field === 'string') continue;
    const definition = projectFields
      .get(field.projectId)
      ?.find((item) => item.id === field.fieldId);
    if (!definition || definition.dataType.toLowerCase().replace('_', '-') !== field.valueType)
      errors.push(`${field.projectId}/${field.fieldId}: field unavailable or incompatible`);
  }
  if (needed.includes('author-teams') && !team.config.githubTeams.length)
    errors.push('Configure GitHub team membership sources before using author-teams');
  candidateLoop: for (const pr of candidates.values()) {
    const subject: PRRuleSubject = {
      pr: { host: account.host, repo: pr.repository.nameWithOwner, number: pr.number },
      headSha: pr.headRefOid,
      title: pr.title,
      observedAt: traversal?.progress.oldestObservationAt ?? new Date().toISOString(),
      facts: {},
    };
    if (onlyPR && monitoredPRKey(subject.pr) !== monitoredPRKey(onlyPR)) continue;
    monitoredPRKey(subject.pr);
    for (const [key, value] of Object.entries({
      repository: pr.repository.nameWithOwner,
      author: pr.author?.login ?? null,
      state: pr.state.toLowerCase(),
      draft: pr.isDraft,
      'base-branch': pr.baseRefName,
      'head-branch': pr.headRefName,
    }))
      subject.facts[key] = { state: 'known', value };
    subject.reviewPolicyFacts = {
      lastActivityAt: pr.updatedAt,
      providerReviewDecision: pr.reviewDecision ?? undefined,
    };
    try {
      const policy = team.config.repositories.find(
        (item) => item.repo.toLowerCase() === pr.repository.nameWithOwner.toLowerCase(),
      );
      if (policy?.approvalTarget !== undefined) {
        const reviews = await connection<{ state: string; author: { login: string } | null }>(
          pr.id,
          'PullRequest',
          'latestOpinionatedReviews',
          'state author { login }',
          account,
          {
            expectedHead: pr.headRefOid,
            expectedBase: pr.baseRefOid,
            traversal,
            dependencies: roots,
          },
        );
        subject.reviewPolicyFacts.approvalCount = new Set(
          reviews
            .filter(
              (review) =>
                review.state === 'APPROVED' &&
                review.author?.login &&
                review.author.login !== pr.author?.login,
            )
            .map((review) => review.author!.login.toLowerCase()),
        ).size;
      }
      const labels = pr.labels.pageInfo.hasNextPage
        ? await connection<{ name: string }>(pr.id, 'PullRequest', 'labels', 'name', account, {
            traversal,
            dependencies: roots,
          })
        : pr.labels.nodes;
      subject.facts.labels = { state: 'known', value: labels.map((label) => label.name).sort() };
      if (needed.includes('changed-paths')) {
        const files = await connection<{ path: string }>(
          pr.id,
          'PullRequest',
          'files',
          'path',
          account,
          {
            expectedHead: pr.headRefOid,
            expectedBase: pr.baseRefOid,
            traversal,
            dependencies: roots,
          },
        );
        subject.facts['changed-paths'] = {
          state: 'known',
          value: files.map((file) => file.path).sort(),
        };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(`${pr.repository.nameWithOwner}#${pr.number}: ${reason}`);
      if (!subject.facts.labels) subject.facts.labels = { state: 'unknown', reason };
      if (needed.includes('changed-paths'))
        subject.facts['changed-paths'] = { state: 'unknown', reason };
      if (traversal?.exhausted) break candidateLoop;
    }
    if (needed.includes('author-teams'))
      subject.facts['author-teams'] =
        memberships.size === team.config.githubTeams.length
          ? {
              state: 'known',
              value: [...memberships]
                .filter(([, members]) => pr.author && members.has(pr.author.login.toLowerCase()))
                .map(([name]) => name)
                .sort(),
            }
          : { state: 'unknown', reason: 'Configured GitHub team membership is incomplete' };
    subject.facts['project-memberships'] =
      projectItems.size ===
      new Set(
        team.config.sources.flatMap((source) =>
          source.kind === 'github-project' ? [source.projectId] : [],
        ),
      ).size
        ? {
            state: 'known',
            value: [...projectItems]
              .filter(([, items]) => items.has(pr.id))
              .map(([id]) => id)
              .sort(),
          }
        : { state: 'unknown', reason: 'Project membership coverage is incomplete' };
    for (const field of needed) {
      if (typeof field === 'string') continue;
      const key = prRuleFieldKey(field);
      const definition = projectFields
        .get(field.projectId)
        ?.find((item) => item.id === field.fieldId);
      if (!definition || definition.dataType.toLowerCase().replace('_', '-') !== field.valueType) {
        subject.facts[key] = {
          state: 'unknown',
          reason: 'Project field is unavailable, deleted or has an incompatible type',
        };
        continue;
      }
      const item = projectItems.get(field.projectId)?.get(pr.id);
      if (!item) {
        subject.facts[key] = { state: 'known', value: null };
        continue;
      }
      try {
        const values = item.fieldValues.pageInfo.hasNextPage
          ? await connection<GitHubProjectValue>(
              item.id,
              'ProjectV2Item',
              'fieldValues',
              GITHUB_PROJECT_VALUE_FIELDS,
              account,
              { traversal, dependencies: roots },
            )
          : item.fieldValues.nodes;
        const value = values.find((candidate) => candidate.field?.id === field.fieldId);
        subject.facts[key] = {
          state: 'known',
          value:
            field.valueType === 'number'
              ? (value?.number ?? null)
              : field.valueType === 'single-select'
                ? (value?.optionId ?? null)
                : field.valueType === 'date'
                  ? (value?.date ?? null)
                  : (value?.text ?? null),
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        subject.facts[key] = { state: 'unknown', reason };
        errors.push(`${field.projectId}/${field.fieldId}: ${reason}`);
        if (traversal?.exhausted) break candidateLoop;
      }
    }
    if (onlyPR && !requireSourceScope) subjects.push(subject);
    else {
      const scope = matchPRSourceScopes(
        subject,
        team.config.sources,
        origins.get(pr.id) ?? new Set(),
      );
      errors.push(...scope.errors);
      if (scope.included) {
        subject.sourceReasons = scope.reasons;
        subjects.push(subject);
      }
    }
  }
  if (targetPR) {
    const final = await query<{ node: { headRefOid: string; baseRefOid?: string } | null }>(
      'query($id:ID!) { node(id:$id) { ... on PullRequest { headRefOid baseRefOid } } }',
      { id: targetPR.id },
      account,
    );
    if (
      final.node?.headRefOid !== targetPR.headRefOid ||
      (targetPR.baseRefOid && final.node?.baseRefOid !== targetPR.baseRefOid)
    ) {
      errors.push('PR head or base changed during observation; refresh before using these facts');
    }
  }
  return { subjects, complete: errors.length === 0, errors: [...new Set(errors)], ignoredItems };
}
