import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import {
  type GitShowResult,
  Methods,
  reviewedFindingContext,
  type ReviewGatePayload,
} from '@farmslot/protocol';
import type { ResourceQuery, ResourceQueryState } from '@farmslot/protocol/client-cache';

let owner = 'owner-a';
let state: ResourceQueryState<GitShowResult> = { status: 'loading' };
let retried: ((value: ResourceQueryState<GitShowResult>) => void) | undefined;
const queries: unknown[] = [];
const cache = {
  retry(query: ResourceQuery<unknown>) {
    assert.equal(query.method, Methods.GIT_SHOW);
    queries.push(query.params);
    if (state.status === 'ready') return Promise.resolve(state);
    return new Promise<ResourceQueryState<GitShowResult>>((resolve) => {
      retried = resolve;
    });
  },
};
mock.module('./resource-cache', {
  namedExports: { getResourceCache: () => (owner === 'owner-a' ? cache : undefined) },
});
// Companion compiles tests as CommonJS, so the mocked module loads inside each test.
const curation = import('./review-curation');

const payload = {
  kind: 'review',
  reviewSnapshot: { headSha: 'a'.repeat(40) },
  lineComments: [{ path: 'src/example.ts', line: 2 }],
} as ReviewGatePayload;

test('finding inspection pins the reviewed SHA for both slot and standalone review', async () => {
  const { reviewFindingSourceRequest } = await curation;
  assert.deepEqual(reviewFindingSourceRequest('review-run', 'slot', payload, 0), {
    slotId: 'slot',
    ref: 'a'.repeat(40),
    path: 'src/example.ts',
  });
  assert.deepEqual(reviewFindingSourceRequest('review-run', null, payload, 0), {
    slotId: '',
    runId: 'review-run',
    ref: 'a'.repeat(40),
    path: 'src/example.ts',
  });
  assert.equal(
    reviewFindingSourceRequest('review-run', 'slot', { ...payload, reviewSnapshot: undefined }, 0),
    null,
  );
  assert.equal(reviewFindingSourceRequest('review-run', 'slot', payload, 99), null);
});

test('review source retains exact numbered source and rejects a stale reply', async () => {
  const { loadReviewFindingSource, reviewFindingSourceRequest } = await curation;
  let current = true;
  const params = reviewFindingSourceRequest('review-run', null, payload, 0)!;
  state = { status: 'ready', data: { content: 'before\nReviewed value\nafter\n' } };
  const context = await loadReviewFindingSource(params, 2, () => current);
  assert.deepEqual(queries.at(-1), params);
  assert.deepEqual(
    context!.lines.find((line) => line.target),
    { number: 2, text: 'Reviewed value', target: true },
  );
  const stale = loadReviewFindingSource(params, 2, () => current);
  current = false;
  assert.equal(await stale, null);
});

test('slot findings read through the shared workspace cache and refuse a late owner', async () => {
  const { loadReviewFindingSource, reviewFindingSourceRequest } = await curation;
  const params = reviewFindingSourceRequest('run', 'slot', payload, 0)!;
  state = { status: 'ready', data: { content: 'before\nReviewed value\n' } };
  const context = await loadReviewFindingSource(params, 2, () => true);
  assert.equal(context?.lines.find((line) => line.target)?.text, 'Reviewed value');
  assert.deepEqual(queries.at(-1), { slotId: 'slot', ref: 'a'.repeat(40), path: 'src/example.ts' });
  state = { status: 'stale', data: { content: 'saved' } };
  const late = loadReviewFindingSource(params, 2, () => true);
  owner = 'owner-b';
  retried?.({ status: 'ready', data: { content: 'other owner' } });
  await assert.rejects(late, /owner changed/);
  owner = 'owner-a';
});

test('missing reviewed files fail without a mutable-workspace fallback', async () => {
  const { loadReviewFindingSource, reviewFindingSourceRequest } = await curation;
  state = { status: 'loading' };
  const missing = loadReviewFindingSource(
    reviewFindingSourceRequest('run', 'slot', payload, 0)!,
    2,
    () => true,
  );
  retried?.({ status: 'error', error: { code: 'READ_FAILED', message: 'Object unavailable' } });
  await assert.rejects(missing, /Object unavailable/);
});

test('selecting a line 462 finding uses the shared exact source-line context', async () => {
  const { reviewFindingSourceRequest } = await curation;
  const linePayload: ReviewGatePayload = {
    kind: 'review',
    prNumber: null,
    repo: null,
    recommendation: 'COMMENT',
    reviewMd: '',
    reviewSnapshot: {
      source: 'github-pr',
      baseRef: 'main',
      baseSha: 'b'.repeat(40),
      headRef: 'feature',
      headSha: 'a'.repeat(40),
      diffPath: 'inputs/diff.txt',
      diffHash: 'fixture',
      diffStat: { files: 1, additions: 1, deletions: 0 },
      capturedAt: '2026-10-21T00:00:00Z',
    },
    lineComments: [
      {
        path: 'mobileInfrastructure.ts',
        line: 462,
        severity: 'suggestion',
        body: 'Check the resulting position',
      },
    ],
  };
  const finding = linePayload.lineComments[0];
  assert.deepEqual(reviewFindingSourceRequest('review-run', null, linePayload, 0), {
    slotId: '',
    runId: 'review-run',
    ref: 'a'.repeat(40),
    path: finding.path,
  });
  const content = Array.from({ length: 500 }, (_, index) => `source line ${index + 1}`).join('\n');
  const context = reviewedFindingContext(content, finding.line);
  assert.deepEqual(
    context.lines.filter((line) => line.target),
    [{ number: 462, text: 'source line 462', target: true }],
  );
  assert.equal(context.lines[0].number, 458);
  assert.equal(context.lines.at(-1)?.number, 466);
});
