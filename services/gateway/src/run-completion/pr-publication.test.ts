import assert from 'node:assert/strict';
import test from 'node:test';

import {
  paginatedPrCommentOutputContainsRun,
  prCommentBelongsToRun,
  prCommentIdentityMarker,
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
