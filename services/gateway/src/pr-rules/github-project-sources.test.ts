import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { PRTeamProfile, PRTriggerRule } from '@farmslot/protocol';

import { collectGitHubPages } from '../integrations/github-graphql.js';

const page = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const pr = {
  id: 'pr',
  number: 1,
  title: 'PR',
  state: 'OPEN',
  isDraft: false,
  headRefOid: 'head',
  baseRefName: 'main',
  headRefName: 'feature',
  author: { login: 'author' },
  repository: { nameWithOwner: 'owner/repo' },
  labels: page([]),
};
let archived: unknown = true;
let itemReads = 0;
let fields = [
  {
    id: 'status',
    name: 'Status',
    dataType: 'SINGLE_SELECT',
    options: [{ id: 'review', name: 'Review' }],
  },
];
mock.module('../pr-monitoring/github-account.js', {
  namedExports: {
    resolvePRSourceAccount: async () => ({ host: 'github.com', token: 'test-only', scope: 'test' }),
  },
});
mock.module('../integrations/github-graphql.js', {
  namedExports: {
    collectGitHubPages,
    githubGraphQL: async (document: string) => {
      if (document.includes('pullRequests')) return { repository: { pullRequests: page([pr]) } };
      if (document.includes('fields(first:')) return { node: { fields: page(fields) } };
      if (document.includes('items(first:')) {
        assert(document.includes('isArchived'), 'Production discovery must request archive state');
        itemReads++;
        return {
          node: {
            items: page([
              {
                id: 'item',
                isArchived: archived,
                content: { ...pr, __typename: 'PullRequest' },
                fieldValues: page([{ field: fields[0], optionId: 'review' }]),
              },
            ]),
          },
        };
      }
      throw new Error('Unexpected provider query');
    },
  },
});
const { collectPRRuleSources } = await import('./github-sources.js');
const team: PRTeamProfile = {
  id: 'team',
  ownerId: 'owner',
  revision: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  config: {
    name: 'Team',
    account: { host: 'github.com', login: 'reader' },
    sources: [{ kind: 'github-project', projectId: 'project', label: 'Board' }],
    predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
    repositories: [],
    githubTeams: [],
    notificationPrincipalIds: [],
  },
};
const rule: PRTriggerRule = {
  id: 'rule',
  ownerId: 'owner',
  revision: 1,
  createdAt: team.createdAt,
  updatedAt: team.updatedAt,
  enabled: false,
  config: {
    name: 'Rule',
    teamId: team.id,
    predicate: team.config.predicate,
    actions: [{ kind: 'notify' }],
    pollIntervalMs: 60_000,
    maxAdmissionsPerScan: 1,
    rereviewOnHeadChange: false,
  },
  scan: { baselinePending: true, backfillRequested: false, subjects: {} },
};

test('archived Project PRs are excluded while independent repository sources stay eligible', async () => {
  archived = true;
  const onlyProject = await collectPRRuleSources(team, rule);
  assert(onlyProject.complete);
  assert.equal(onlyProject.subjects.length, 0);
  assert.equal(onlyProject.ignoredItems, 1);
  const mixed = await collectPRRuleSources(
    {
      ...team,
      config: {
        ...team.config,
        sources: [...team.config.sources, { kind: 'repository', repo: 'owner/repo' }],
      },
    },
    rule,
  );
  assert(mixed.complete);
  assert.equal(mixed.subjects.length, 1);
  assert.deepEqual(mixed.subjects[0].facts['project-memberships'], { state: 'known', value: [] });
});

test('overlapping views read Project items once and retain both matching source reasons', async () => {
  archived = false;
  itemReads = 0;
  const source = team.config.sources[0];
  assert(source.kind === 'github-project');
  const result = await collectPRRuleSources(
    {
      ...team,
      config: {
        ...team.config,
        sources: [
          source,
          {
            ...source,
            importedView: {
              number: 1,
              name: 'PRs',
              filter: 'is:pr',
              terms: [{ text: 'is:pr', kind: 'constant', value: true }],
            },
          },
        ],
      },
    },
    rule,
  );
  assert(result.complete);
  assert.equal(itemReads, 1);
  assert.equal(result.subjects.length, 1);
  assert.deepEqual(result.subjects[0].sourceReasons, ['Project Board', 'Project Board / PRs']);
});

test('missing archive state and deleted option bindings make source coverage incomplete', async () => {
  archived = undefined;
  const missingArchive = await collectPRRuleSources(team, rule);
  assert.equal(missingArchive.complete, false);
  assert.match(missingArchive.errors.join('; '), /archive state/);
  archived = false;
  const boundRule = {
    ...rule,
    config: {
      ...rule.config,
      predicate: {
        kind: 'compare' as const,
        field: { projectId: 'project', fieldId: 'status', valueType: 'single-select' as const },
        operator: 'equals' as const,
        value: 'review',
      },
    },
  };
  fields = [{ ...fields[0], options: [] }];
  const deletedOption = await collectPRRuleSources(team, boundRule);
  assert.equal(deletedOption.complete, false);
  assert.match(deletedOption.errors.join('; '), /option review.*deleted/);
});
