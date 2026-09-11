import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRMonitor, PRReviewIntent, PRStatus } from '@farmslot/protocol';

import {
  prBoardUrlStateFromHash,
  prBoardUrlStateHash,
  prKeyEqual,
  prReviewDispatchHash,
} from './pr-board-url-state.js';
import { buildPRWorkspaceEntries, prWorkspaceKey, prWorkspaceNavigation } from './pr-workspace.js';

const status = {
  repo: 'Org/App',
  pr: 7,
  title: 'Existing PR',
  project: 'mobile',
  slot: 'mini-mobile-1',
  ownedFamily: true,
} as PRStatus;
const monitor: PRMonitor = {
  id: 'monitor',
  ownerId: 'owner',
  revision: 1,
  lifecycle: 'active',
  createdAt: '',
  updatedAt: '',
  originatingRunIds: [],
  incidents: [],
  config: {
    pr: { host: 'github.com', repo: 'org/app', number: 7 },
    account: { host: 'github.com', login: 'reader' },
    project: 'mobile',
    policy: { mode: 'notify-only' },
    pollIntervalMs: 7200000,
    watchedChecks: [],
    automaticAttemptLimit: 2,
    cooldownMs: 60000,
  },
};
const review: PRReviewIntent = {
  id: 'review',
  pr: { host: 'github.com', repo: 'org/app', number: 7 },
  headSha: 'head',
  reviewProfile: 'standard',
  status: 'held',
  contributions: [],
  createdAt: '',
  updatedAt: '',
};
const filters = { projects: [], machines: [] };

test('one PR combines viewer, monitoring, and reviews without losing account-specific subscriptions', () => {
  const entries = buildPRWorkspaceEntries(
    [status],
    [monitor, { ...monitor, id: 'second-account' }],
    [review],
    [],
    [],
    filters,
    false,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, status);
  assert.equal(entries[0].monitors.length, 2);
  assert.equal(entries[0].reviews.length, 1);
  assert.equal(entries[0].title, 'Existing PR');
});

test('monitor-only and review-only PRs remain selectable without fabricating viewer status', () => {
  const entries = buildPRWorkspaceEntries(
    [],
    [monitor],
    [{ ...review, pr: { ...review.pr, number: 8 } }],
    [],
    [],
    filters,
    false,
  );
  assert.equal(entries.length, 2);
  assert(entries.every((entry) => entry.status === undefined));
  assert.equal(entries[0].project, 'mobile');
});

test('repository and host identity prevent same-number PR collisions', () => {
  const otherRepo = {
    ...monitor,
    id: 'other-repo',
    config: { ...monitor.config, pr: { ...monitor.config.pr, repo: 'org/other' } },
  };
  const otherHost = {
    ...monitor,
    id: 'other-host',
    config: { ...monitor.config, pr: { ...monitor.config.pr, host: 'git.example.com' } },
  };
  const entries = buildPRWorkspaceEntries(
    [status],
    [monitor, otherRepo, otherHost],
    [],
    [],
    [],
    filters,
    false,
  );
  assert.equal(entries.length, 3);
  assert.equal(new Set(entries.map((entry) => prWorkspaceKey(entry.key))).size, 3);
  assert(prKeyEqual({ repo: 'Org/App', pr: 7 }, { repo: 'org/app', pr: 7, host: 'github.com' }));
  assert(!prKeyEqual(entries[0].key, entries[2].key));
  const hash = prBoardUrlStateHash(
    { selectedPr: entries[2].key, modalPr: null, layout: 'list' },
    '#prs',
  )!;
  assert.deepEqual(prBoardUrlStateFromHash([], hash)?.selectedPr, entries[2].key);
});

test('history, global scope, and cached details do not introduce unrelated PRs', () => {
  assert.equal(
    buildPRWorkspaceEntries([], [{ ...monitor, lifecycle: 'stopped' }], [], [], [], filters, false)
      .length,
    0,
  );
  assert.equal(
    buildPRWorkspaceEntries([], [{ ...monitor, lifecycle: 'stopped' }], [], [], [], filters, true)
      .length,
    1,
  );
  assert.equal(
    buildPRWorkspaceEntries(
      [status],
      [monitor],
      [],
      [],
      [],
      { projects: ['other'], machines: [] },
      false,
    ).length,
    0,
  );
  assert.equal(
    buildPRWorkspaceEntries(
      [status],
      [monitor],
      [],
      [],
      [],
      { projects: [], machines: ['mini'] },
      false,
    ).length,
    1,
  );
  assert.equal(buildPRWorkspaceEntries([], [], [], [], [], filters, false, [status]).length, 0);
});

test('legacy sections migrate and explicit workspace navigation takes precedence', () => {
  assert.equal(prWorkspaceNavigation('#prs?prTab=monitors').scope, 'monitored');
  assert.equal(prWorkspaceNavigation('#prs?prTab=reviews').section, 'reviews');
  assert.equal(prWorkspaceNavigation('#prs?prTab=policies').section, 'automation');
  assert.equal(prWorkspaceNavigation('#prs?prEditor=team').section, 'automation');
  assert.deepEqual(
    prWorkspaceNavigation('#prs?prSection=prs&prScope=monitored&prPane=overview&prTab=rules'),
    { section: 'prs', scope: 'monitored', pane: 'overview', history: false },
  );
});

test('machine filters retain unassigned tracked PRs while respecting known slot assignments', () => {
  const machine = { projects: [], machines: ['mini'] };
  assert.equal(buildPRWorkspaceEntries([], [monitor], [], [], [], machine, false).length, 1);
  assert.equal(buildPRWorkspaceEntries([], [], [review], [], [], machine, false).length, 1);
  assert.equal(
    buildPRWorkspaceEntries([{ ...status, slot: null }], [], [], [], [], machine, false).length,
    0,
  );
  const assigned = {
    ...monitor,
    activeRuns: [{ id: 'run', slotId: 'other-slot', status: 'monitoring' as const }],
  };
  assert.equal(buildPRWorkspaceEntries([], [assigned], [], [], [], machine, false).length, 0);
});

test('manual review setup keeps the canonical PR and project without starting work', () => {
  const hash = prReviewDispatchHash(
    { repo: 'org/app', pr: 7, project: 'mobile' },
    '#prs?machines=mini&projects=mobile',
  );
  assert.equal(
    hash,
    '#dispatch?flow=review-pr&ticket=org%2Fapp%237&project=mobile&projects=mobile&machines=mini',
  );
});

test('review discovery author and title appear without fetching viewer data or using the account identity', () => {
  const entries = buildPRWorkspaceEntries(
    [],
    [monitor],
    [{ ...review, title: 'Teammate PR', author: 'teammate' }],
    [],
    [],
    filters,
    false,
  );
  assert.equal(entries[0].title, 'Teammate PR');
  assert.equal(entries[0].author, 'teammate');
  assert.equal(entries[0].status, undefined);
  assert.equal(
    buildPRWorkspaceEntries([], [monitor], [review], [], [], filters, false)[0].author,
    undefined,
  );
});
