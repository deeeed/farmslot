import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { PRTeamProfile, PRTriggerRule } from '@farmslot/protocol';

import { collectGitHubPages } from '../integrations/github-graphql.js';

import { buildPRReviewPreviewItem } from './preview.js';

const page = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const pr = {
  id: 'pr',
  number: 1,
  title: 'PR',
  updatedAt: '2026-01-01T00:00:00Z',
  reviewDecision: 'CHANGES_REQUESTED',
  viewerLatestReview: {
    state: 'APPROVED',
    submittedAt: '2026-01-01T00:00:00Z',
    commit: { oid: 'head-a' },
  },
  viewerLatestReviewRequest: null,
  state: 'OPEN',
  isDraft: false,
  headRefOid: 'head-a',
  baseRefOid: 'base-a',
  baseRefName: 'main',
  headRefName: 'feature',
  author: { login: 'author' },
  repository: { nameWithOwner: 'owner/repo' },
  labels: page([]),
};
let filesHead = pr.headRefOid;
let finalHead = pr.headRefOid;
let archived = false;
const documents: string[] = [];
mock.module('../pr-monitoring/github-account.js', {
  namedExports: {
    resolvePRSourceAccount: async () => ({ host: 'github.com', token: 'test-only', scope: 'test' }),
  },
});
mock.module('../integrations/github-graphql.js', {
  namedExports: {
    collectGitHubPages,
    githubGraphQL: async (document: string) => {
      documents.push(document);
      if (document.includes('pullRequest(number:')) return { repository: { pullRequest: pr } };
      if (document.includes('projectItems(first:')) {
        assert(document.includes('includeArchived:true'));
        return {
          node: {
            projectItems: page([
              {
                id: 'item',
                project: { id: 'project' },
                isArchived: archived,
                fieldValues: page([]),
              },
            ]),
          },
        };
      }
      if (document.includes('fields(first:')) return { node: { fields: page([]) } };
      if (document.includes('files(first:'))
        return {
          node: {
            headRefOid: filesHead,
            baseRefOid: pr.baseRefOid,
            files: page([{ path: 'src/fix.ts' }]),
          },
        };
      if (document.includes('latestOpinionatedReviews(first:'))
        return {
          node: {
            ...pr,
            latestOpinionatedReviews: page([
              { state: 'APPROVED', author: { login: 'reviewer' } },
              { state: 'APPROVED', author: { login: 'reviewer' } },
              { state: 'DISMISSED', author: { login: 'dismissed' } },
              { state: 'APPROVED', author: { login: 'author' } },
            ]),
          },
        };
      if (document.includes('headRefOid baseRefOid'))
        return { node: { headRefOid: finalHead, baseRefOid: pr.baseRefOid } };
      throw new Error(`Unexpected full source traversal: ${document}`);
    },
  },
});
const { collectPRRuleTarget } = await import('./github-sources.js');
const team: PRTeamProfile = {
  id: 'team',
  ownerId: 'owner',
  revision: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  config: {
    name: 'Team',
    account: { host: 'github.com', login: 'reader' },
    sources: [
      { kind: 'repository', repo: 'another/repo' },
      { kind: 'github-project', projectId: 'project', label: 'Board' },
    ],
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
  enabled: true,
  createdAt: team.createdAt,
  updatedAt: team.updatedAt,
  config: {
    name: 'Rule',
    teamId: team.id,
    predicate: {
      kind: 'compare',
      field: 'changed-paths',
      operator: 'contains-any',
      value: ['src/fix.ts'],
    },
    actions: [{ kind: 'notify' }],
    pollIntervalMs: 300_000,
    maxAdmissionsPerScan: 10,
    rereviewOnHeadChange: true,
  },
  scan: { baselinePending: false, backfillRequested: false, subjects: {} },
};
const identity = { host: 'github.com', repo: 'owner/repo', number: 1 };

test('configured supplemental policy uses unique current approvals and provider activity without overriding GitHub requirements', async () => {
  filesHead = pr.headRefOid;
  finalHead = pr.headRefOid;
  archived = false;
  const configured: PRTeamProfile = {
    ...team,
    config: {
      ...team.config,
      sources: [{ kind: 'repository', repo: 'owner/repo' }],
      repositories: [
        {
          repo: 'owner/repo',
          reviewProfile: 'standard',
          excludedLabels: [],
          approvalTarget: 1,
          staleAfterDays: 3,
        },
      ],
    },
  };
  const scan = await collectPRRuleTarget(configured, rule, identity);
  assert.equal(scan.complete, true);
  const subject = scan.subjects[0];
  assert.equal(subject.reviewObservation?.reviewer, 'reader');
  assert.equal(subject.reviewObservation?.review?.commit, 'head-a');
  assert.equal(subject.reviewObservation?.requested, false);
  assert.equal(subject.reviewPolicyFacts?.approvalCount, 1);
  const preview = buildPRReviewPreviewItem(configured, subject, rule.config.predicate);
  assert(preview.policySummary?.includes('Supplemental approvals: 1/1 (target met)'));
  assert(preview.policySummary?.includes('GitHub review requirement: CHANGES_REQUESTED'));
  assert(preview.policySummary?.some((line) => line.startsWith('Activity: inactive')));
  const recent = { ...subject, observedAt: '2026-01-02T00:00:00Z' };
  assert(
    buildPRReviewPreviewItem(configured, recent, rule.config.predicate).policySummary?.some(
      (line) => line.startsWith('Activity: recent'),
    ),
  );
});

test('targeted rule eligibility reads this PR and its current memberships without enumerating Project PRs', async () => {
  const scan = await collectPRRuleTarget(team, rule, identity);
  assert.equal(scan.complete, true);
  assert.equal(scan.subjects.length, 1);
  assert.deepEqual(scan.subjects[0].facts['changed-paths'], {
    state: 'known',
    value: ['src/fix.ts'],
  });
  assert.deepEqual(scan.subjects[0].facts['project-memberships'], {
    state: 'known',
    value: ['project'],
  });
  assert(
    !documents.some(
      (document) => document.includes('pullRequests(') || document.includes('items(first:'),
    ),
  );
  archived = true;
  const removed = await collectPRRuleTarget(team, rule, identity);
  assert.equal(removed.complete, true);
  assert.equal(
    removed.subjects.length,
    0,
    'Archived Project membership cannot retain source eligibility',
  );
  archived = false;
});

test('file facts and final admission metadata cannot silently span different PR heads', async () => {
  filesHead = 'head-b';
  const movedDuringFiles = await collectPRRuleTarget(team, rule, identity);
  assert.equal(movedDuringFiles.complete, false);
  assert(movedDuringFiles.errors.some((error) => error.includes('head changed')));
  filesHead = pr.headRefOid;
  finalHead = 'head-b';
  const movedAfterFiles = await collectPRRuleTarget(team, rule, identity);
  assert.equal(movedAfterFiles.complete, false);
  assert(movedAfterFiles.errors.some((error) => error.includes('head or base changed')));
  finalHead = pr.headRefOid;
});
