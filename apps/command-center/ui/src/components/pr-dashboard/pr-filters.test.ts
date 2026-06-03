import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRStatus } from '@farmslot/protocol';

import { buildPRDashboardScopeSummary, filterDashboardPRs } from './pr-filters.js';

function pr(overrides: Partial<PRStatus>): PRStatus {
  return {
    repo: 'owner/repo',
    pr: 1,
    project: 'mobile',
    title: 'Example PR',
    branch: 'feature',
    recommendation: 'WORKING',
    summary: null,
    slot: 'runner-local-mobile-1',
    workerActive: false,
    checks: [],
    checkSummary: { total: 0, passed: 0, failed: 0, pending: 0 },
    allCheckSummary: { total: 0, passed: 0, failed: 0, pending: 0 },
    failedNames: [],
    allFailedNames: [],
    anyFailed: false,
    mergeConflict: false,
    merged: false,
    botComments: [],
    actionableBotComments: [],
    prState: 'OPEN',
    ownedFamily: true,
    ...overrides,
  } as PRStatus;
}

test('filterDashboardPRs applies owned family, project, and machine filters', () => {
  const prs = [
    pr({ pr: 1, project: 'mobile', slot: 'runner-local-mobile-1', ownedFamily: true }),
    pr({ pr: 2, project: 'mobile', slot: 'mini-mm-1', ownedFamily: true }),
    pr({ pr: 3, project: 'extension', slot: 'runner-local-browser-1', ownedFamily: true }),
    pr({ pr: 4, project: 'mobile', slot: 'runner-local-mobile-2', ownedFamily: false }),
  ];

  assert.deepEqual(
    filterDashboardPRs(prs, { projects: ['mobile'], machines: ['runner-local'] }).map(
      (item) => item.pr,
    ),
    [1],
  );
});

test('filterDashboardPRs handles hyphenated machine ids', () => {
  const prs = [
    pr({ pr: 10, project: 'mobile', slot: 'macwork-lan-mobile-1', ownedFamily: true }),
    pr({ pr: 11, project: 'mobile', slot: 'macwork-mobile-1', ownedFamily: true }),
  ];

  assert.deepEqual(
    filterDashboardPRs(prs, { projects: ['mobile'], machines: ['macwork-lan'] }).map(
      (item) => item.pr,
    ),
    [10],
  );
});

test('buildPRDashboardScopeSummary separates visible owned, scope-hidden, and review-only PRs', () => {
  const prs = [
    pr({ pr: 1, project: 'mobile', slot: 'runner-local-mobile-1', ownedFamily: true }),
    pr({ pr: 2, project: 'mobile', slot: 'mini-mm-1', ownedFamily: true }),
    pr({ pr: 3, project: 'extension', slot: 'runner-local-browser-1', ownedFamily: true }),
    pr({ pr: 4, project: 'mobile', slot: 'runner-local-mobile-2', ownedFamily: false }),
  ];

  const scope = buildPRDashboardScopeSummary(prs, {
    projects: ['mobile', 'extension'],
    machines: ['runner-local'],
  });

  assert.equal(scope.visibleOwned, 2);
  assert.equal(scope.ownedTotal, 3);
  assert.equal(scope.gatewayTotal, 4);
  assert.equal(scope.hiddenByScope, 1);
  assert.equal(scope.reviewOnly, 1);
  assert.equal(
    scope.summary,
    '2/3 owned visible · 4 gateway · mobile, extension, runner-local · 1 hidden by scope · 1 review-only',
  );
});
