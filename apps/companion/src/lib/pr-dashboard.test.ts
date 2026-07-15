import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRStatus } from '@farmslot/protocol';

import {
  buildPRDashboardRows,
  buildPRDashboardScope,
  filterDashboardPRs,
  latestPRActivityTs,
  sortDashboardPRs,
} from './pr-dashboard';
import { prRepoFromWorkspaceSource } from './pr-links';

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
    checkSummary: { skipped: 0, total: 0, passed: 0, failed: 0, pending: 0 },
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

test('buildPRDashboardScope separates scope-hidden owned PRs from review-only gateway PRs', () => {
  const prs = [
    pr({ pr: 1, project: 'mobile', slot: 'runner-local-mobile-1', ownedFamily: true }),
    pr({ pr: 2, project: 'mobile', slot: 'mini-mm-1', ownedFamily: true }),
    pr({ pr: 3, project: 'extension', slot: 'runner-local-browser-1', ownedFamily: true }),
    pr({ pr: 4, project: 'mobile', slot: 'runner-local-mobile-2', ownedFamily: false }),
  ];

  assert.deepEqual(
    buildPRDashboardScope(prs, { projects: ['mobile'], machines: ['runner-local'] }),
    {
      visibleOwned: 1,
      ownedTotal: 3,
      gatewayTotal: 4,
      hiddenByScope: 2,
      reviewOnly: 1,
      scopeLabel: 'mobile, runner-local',
      summary:
        '1/3 owned visible · 4 gateway · mobile, runner-local · 2 hidden by scope · 1 review-only',
    },
  );
});

test('sortDashboardPRs mirrors command-center group order and preserves gateway order within groups', () => {
  const prs = [
    pr({ pr: 10, recommendation: 'READY' }),
    pr({ pr: 11, recommendation: 'NEEDS_ATTENTION' }),
    pr({ pr: 12, recommendation: 'WORKING' }),
    pr({ pr: 13, recommendation: 'NEEDS_ATTENTION' }),
    pr({ pr: 14, recommendation: 'IN_REVIEW' }),
  ];

  assert.deepEqual(
    sortDashboardPRs(prs, 'group').map((item) => item.pr),
    [12, 11, 13, 14, 10],
  );
});

test('sortDashboardPRs date mode mirrors command-center latest activity proxy', () => {
  const prs = [
    pr({ pr: 10, botComments: [{ createdAt: '2026-01-01T00:00:00Z' }] as PRStatus['botComments'] }),
    pr({ pr: 99, botComments: [] }),
    pr({ pr: 12, botComments: [{ createdAt: '2026-02-01T00:00:00Z' }] as PRStatus['botComments'] }),
  ];

  assert.equal(latestPRActivityTs(prs[1]), 99);
  assert.deepEqual(
    sortDashboardPRs(prs, 'date').map((item) => item.pr),
    [12, 10, 99],
  );
});

test('buildPRDashboardRows adds command-center style group headers only for visible groups', () => {
  const rows = buildPRDashboardRows(
    [
      pr({ pr: 1, recommendation: 'NEEDS_ATTENTION' }),
      pr({ pr: 2, recommendation: 'READY' }),
      pr({ pr: 3, recommendation: 'NEEDS_ATTENTION' }),
    ],
    'group',
  );

  assert.deepEqual(
    rows.map((row) => (row.kind === 'group' ? `${row.group.label}:${row.count}` : `#${row.pr.pr}`)),
    ['Needs Attention:2', '#1', '#3', 'Ready to Merge:1', '#2'],
  );
});

test('prRepoFromWorkspaceSource resolves focused PR repos from refs and links', () => {
  assert.equal(
    prRepoFromWorkspaceSource({ ticketOrPr: 'example-org/example-mobile#30125' }, 30125),
    'example-org/example-mobile',
  );
  assert.equal(
    prRepoFromWorkspaceSource(
      {
        ticketOrPr: 'PROJ-3011',
        links: [
          { label: 'Jira', url: 'https://example.com/PROJ-3011' },
          { label: 'PR', url: 'https://github.com/example-org/example-browser/pull/42715' },
        ],
      },
      42715,
    ),
    'example-org/example-browser',
  );
  assert.equal(
    prRepoFromWorkspaceSource(
      {
        ticketOrPr: 'owner/other#1',
        links: [{ label: 'PR', url: 'https://github.com/owner/repo/pull/2' }],
      },
      2,
    ),
    'owner/repo',
  );
  assert.equal(prRepoFromWorkspaceSource({ ticketOrPr: 'PROJ-3011' }, 42715), null);
});
