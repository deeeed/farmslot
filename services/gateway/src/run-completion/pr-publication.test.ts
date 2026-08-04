import assert from 'node:assert/strict';
import test from 'node:test';

import {
  paginatedPrCommentOutputContainsRun,
  prCommentBelongsToRun,
  prCommentIdentityMarker,
  resolvePrReadyAction,
  shouldPostWorkerReportComment,
} from './pr-publication.js';

test('PR ready action is idempotent across lifecycle states', () => {
  assert.equal(
    resolvePrReadyAction({ state: 'MERGED', isDraft: false, mergedAt: '2026-08-04T09:37:17Z' }),
    'merged',
  );
  assert.equal(
    resolvePrReadyAction({ state: 'OPEN', isDraft: false, mergedAt: null }),
    'already-ready',
  );
  assert.equal(
    resolvePrReadyAction({ state: 'OPEN', isDraft: true, mergedAt: null }),
    'mark-ready',
  );
  assert.equal(resolvePrReadyAction({ state: 'CLOSED', isDraft: false, mergedAt: null }), 'closed');
});

test('PR comment identity is stable per run and supports legacy comments', () => {
  const runId = 'b26f39be-fb72-407b-ac77-47fdea539fb9';

  assert.equal(prCommentIdentityMarker(runId), `<!-- farmslot-run:${runId} -->`);
  assert.equal(prCommentBelongsToRun(`<!-- farmslot-run:${runId} -->\nreport`, runId), true);
  assert.equal(prCommentBelongsToRun('## Automated run\n| Run | `b26f39be` |', runId), true);
  assert.equal(
    prCommentBelongsToRun(`## Automated run\nRun ID: ${runId.slice(0, 8)}`, runId),
    true,
  );
  assert.equal(prCommentBelongsToRun(`unrelated commit ${runId.slice(0, 8)}`, runId), false);
  assert.equal(prCommentBelongsToRun('<!-- farmslot-run:another-run -->', runId), false);
  assert.equal(
    paginatedPrCommentOutputContainsRun(
      `${JSON.stringify('older comment')}\n${JSON.stringify(`<!-- farmslot-run:${runId} -->`)}`,
      runId,
    ),
    true,
  );
  assert.equal(
    paginatedPrCommentOutputContainsRun(`null\nnot-json\n${JSON.stringify('another run')}`, runId),
    false,
  );
});

test('worker report comments exclude flows whose report is the PR description', () => {
  assert.equal(shouldPostWorkerReportComment('dev', 'pr-description.md'), false);
  assert.equal(shouldPostWorkerReportComment('fix-bug', 'pr-description.md'), false);
  assert.equal(shouldPostWorkerReportComment('dev', 'report.md'), true);
  assert.equal(shouldPostWorkerReportComment('review-pr', 'review.md'), true);
  assert.equal(shouldPostWorkerReportComment('pr-complete', 'comments-report.md'), true);
  assert.equal(shouldPostWorkerReportComment('update-branch', 'report.md'), true);
});
