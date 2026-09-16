import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPRReviewRequest } from '../../src/integrations/pr-rule-config.js';

test('sourceReviewRunId is an explicit QA-only request field; frozen provenance is gateway-owned', () => {
  const request = {
    teamId: 'team',
    pr: { host: 'github.com', repo: 'example/app', number: 42 },
    idempotencyKey: 'key',
    autoStart: false,
    source: { client: 'test' },
    sourceReviewRunId: 'source-run',
    review: { sessionIntent: 'reset', scope: 'full', workflow: 'qa' },
  };
  assert.doesNotThrow(() => assertPRReviewRequest(request));
  assert.doesNotThrow(() =>
    assertPRReviewRequest({ ...request, sourceReviewRunId: undefined, review: undefined }),
  );
  for (const review of [undefined, { sessionIntent: 'reset', scope: 'full', workflow: 'review' }])
    assert.throws(() => assertPRReviewRequest({ ...request, review }), /only allowed for QA/);
  for (const sourceReviewRunId of ['', ' source', 'source '])
    assert.throws(() => assertPRReviewRequest({ ...request, sourceReviewRunId }));
  assert.throws(
    () =>
      assertPRReviewRequest({
        ...request,
        sourceReview: { runId: 'source-run', headSha: 'a'.repeat(40) },
      }),
    /Unsupported property/,
  );
});
