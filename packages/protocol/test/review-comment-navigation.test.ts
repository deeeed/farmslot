import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewLineComment } from '../src/contracts/runs.js';
import {
  parseReviewCommentLocation,
  reviewCommentIndex,
  reviewCommentLocation,
  writeReviewCommentLocation,
} from '../src/runs/review-comment-navigation.js';
import { viewLinkFromRoute, viewRouteFromLink } from '../src/surfaces/view-links.js';

const head = '03f5642c4ddfafb8036cb6d1556af88bb21ad0f4';
const finding: ReviewLineComment = {
  path: 'app/components/UI/Perps/hooks/usePerpsCloseAllCalculations.ts',
  line: 479,
  body: 'Keep the reviewed calculation.',
  severity: 'major',
};

test('a shareable line-479 location restores the exact finding and reviewed revision', () => {
  const location = reviewCommentLocation(finding, head);
  const params = new URLSearchParams('run=review&tab=review');
  writeReviewCommentLocation(params, location);
  const route = `#runs?${params}`;
  assert.equal(viewRouteFromLink(viewLinkFromRoute(route)), route);
  const restored = parseReviewCommentLocation(new URLSearchParams(route.split('?')[1]));
  assert.deepEqual(restored, location);
  assert.equal(reviewCommentIndex([finding], restored!, head), 0);
  assert.equal(restored?.line, 479);
  assert.equal(restored?.head, head);
});

test('finding identity survives reordering and refuses replaced findings or another revision', () => {
  const other = { ...finding, body: 'Another finding at the same line.' };
  const location = reviewCommentLocation(finding, head);
  assert.equal(reviewCommentIndex([other, finding], location, head), 1);
  assert.equal(reviewCommentIndex([other], location, head), -1);
  assert.equal(reviewCommentIndex([finding], location, 'b'.repeat(40)), -1);
});

test('file navigation clears the finding while retaining unrelated view state', () => {
  const params = new URLSearchParams('run=review&tab=review');
  writeReviewCommentLocation(params, reviewCommentLocation(finding, head));
  writeReviewCommentLocation(params, { file: 'other.ts' });
  assert.deepEqual(parseReviewCommentLocation(params), {
    file: 'other.ts',
    line: undefined,
    comment: undefined,
    head: undefined,
  });
  writeReviewCommentLocation(params, null);
  assert.equal(parseReviewCommentLocation(params), undefined);
  assert.equal(params.toString(), 'run=review&tab=review');
});
