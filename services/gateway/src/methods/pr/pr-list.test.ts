import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { PRStatus } from '@farmslot/protocol';

import {
  isListReadOutage,
  prList,
  type PRListFetchResult,
  summarizeReviewMeta,
  trackedPRCandidates,
} from '../pr.js';

import { resetPRListCacheForTests, servePRList } from './list-cache.js';

function pr(n: number, project: string): PRStatus {
  return { pr: n, repo: 'org/app', title: `PR ${n}`, project, prState: 'OPEN' } as PRStatus;
}

test('project-scoped pr.list filters the warm copy, or rediscovers per project once that copy is capped', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-list-'));
  const previous = process.env.FARMSLOT_DIR;
  process.env.FARMSLOT_DIR = dir;
  resetPRListCacheForTests();
  try {
    const calls: Array<{ force?: boolean; project?: string }> = [];
    const fetchList = async (opts: { force?: boolean; project?: string }) => {
      calls.push(opts);
      const result: PRListFetchResult = {
        prs: [pr(3, 'b'), pr(4, 'a')],
        truncated: false,
        failed: [],
      };
      return result;
    };
    await servePRList(async () => ({
      prs: [pr(1, 'a'), pr(2, 'b')],
      truncated: false,
      failed: [],
    }));
    const filtered = await prList({ project: 'b' }, fetchList);
    assert.deepEqual(calls, [], 'a complete warm copy is filtered, not refetched');
    assert.deepEqual(
      filtered.prs.map((p) => p.pr),
      [2],
    );

    resetPRListCacheForTests();
    await servePRList(async () => ({ prs: [pr(1, 'a'), pr(2, 'b')], truncated: true, failed: [] }));
    const rediscovered = await prList({ project: 'b' }, fetchList);
    assert.deepEqual(calls, [{ project: 'b', force: undefined }]);
    assert.deepEqual(
      rediscovered.prs.map((p) => p.pr),
      [3],
      'rediscovery result is filtered by project too',
    );
    assert.equal(rediscovered.refreshing, false);
  } finally {
    resetPRListCacheForTests();
    if (previous === undefined) delete process.env.FARMSLOT_DIR;
    else process.env.FARMSLOT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fetch is an outage only when nothing could be read and it was not one deleted PR', () => {
  assert.equal(isListReadOutage({ candidates: 0, failed: 0, gone: 0 }), false, 'empty farm');
  assert.equal(isListReadOutage({ candidates: 1, failed: 0, gone: 1 }), false, 'one deleted PR');
  assert.equal(
    isListReadOutage({ candidates: 1, failed: 1, gone: 0 }),
    true,
    'lone transient failure',
  );
  assert.equal(
    isListReadOutage({ candidates: 3, failed: 0, gone: 3 }),
    true,
    'mass 404 is lost access',
  );
  assert.equal(
    isListReadOutage({ candidates: 3, failed: 1, gone: 2 }),
    true,
    'nothing read at all',
  );
  assert.equal(
    isListReadOutage({ candidates: 3, failed: 2, gone: 0 }),
    false,
    'one read succeeded',
  );
});

test('tracked PRs become dashboard candidates only when a project owns their repo', () => {
  const projects = [
    { name: 'mobile', ci: { repo: 'MetaMask/metamask-mobile' } },
    { name: 'ext', ci: { repo: 'MetaMask/metamask-extension' } },
    { name: 'no-ci', ci: {} },
  ] as Array<{ name: string; ci: { repo?: string } }>;
  const out = trackedPRCandidates(
    [
      { host: 'github.com', repo: 'metamask/metamask-mobile', number: 7 },
      { host: 'github.com', repo: 'MetaMask/metamask-mobile', number: 7 },
      { host: 'github.com', repo: 'MetaMask/metamask-extension', number: 9 },
      { host: 'github.com', repo: 'someone/else', number: 1 },
      { host: 'github.example.com', repo: 'MetaMask/metamask-mobile', number: 8 },
    ],
    projects as never,
  );
  assert.deepEqual(out, [
    { pr: 7, repo: 'MetaMask/metamask-mobile', project: 'mobile' },
    { pr: 9, repo: 'MetaMask/metamask-extension', project: 'ext' },
  ]);
});

test('review meta folds into latest reviews, requests, and the pushed-after-changes signal', () => {
  const lines = [
    {
      t: 'review',
      author: 'alice',
      state: 'CHANGES_REQUESTED',
      submittedAt: '2026-09-14T10:00:00Z',
    },
    { t: 'review', author: 'carol', state: 'APPROVED', submittedAt: '2026-09-14T11:00:00Z' },
    { t: 'request', kind: 'team', name: 'Engagement' },
    { t: 'request', kind: 'user', name: 'bob' },
    { t: 'request', kind: 'team', name: '' },
  ];
  const pushed = summarizeReviewMeta(lines, '2026-09-14T12:00:00Z');
  assert.deepEqual(pushed.reviewRequests, { teams: ['Engagement'], users: ['bob'] });
  assert.equal(pushed.reviewVerdicts.length, 2);
  assert.equal(pushed.pushedAfterChangesRequested, true);
  const notPushed = summarizeReviewMeta(lines, '2026-09-14T09:00:00Z');
  assert.equal(notPushed.pushedAfterChangesRequested, false);
  const noCommit = summarizeReviewMeta(lines, null);
  assert.equal(noCommit.pushedAfterChangesRequested, false);
  assert.equal(summarizeReviewMeta([], '2026-09-14T12:00:00Z').pushedAfterChangesRequested, false);
});
