import assert from 'node:assert/strict';
import test from 'node:test';

import {
  paginatedPrCommentOutputContainsRun,
  prCommentBelongsToRun,
  prCommentIdentityMarker,
  shouldPostWorkerReportComment,
} from './pr-publication.js';

test('PR comment identity is stable per run and supports legacy comments', () => {
  const runId = 'b26f39be-fb72-407b-ac77-47fdea539fb9';

  assert.equal(prCommentIdentityMarker(runId), `<!-- farmslot-run:${runId} -->`);
  assert.equal(prCommentBelongsToRun(`<!-- farmslot-run:${runId} -->\nreport`, runId), true);
  assert.equal(prCommentBelongsToRun('| Run | `b26f39be` |', runId), true);
  assert.equal(prCommentBelongsToRun('<!-- farmslot-run:another-run -->', runId), false);
  assert.equal(
    paginatedPrCommentOutputContainsRun(
      `${JSON.stringify('older comment')}\n${JSON.stringify(`<!-- farmslot-run:${runId} -->`)}`,
      runId,
    ),
    true,
  );
});

test('worker report comments exclude flows whose report is the PR description', () => {
  assert.equal(shouldPostWorkerReportComment('dev'), false);
  assert.equal(shouldPostWorkerReportComment('fix-bug'), false);
  assert.equal(shouldPostWorkerReportComment('review-pr'), true);
  assert.equal(shouldPostWorkerReportComment('pr-complete'), true);
  assert.equal(shouldPostWorkerReportComment('update-branch'), true);
});
