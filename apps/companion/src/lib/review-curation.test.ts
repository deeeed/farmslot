import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods, reviewedFindingContext, type ReviewGatePayload } from '@farmslot/protocol';

import { loadReviewFindingSource, reviewFindingSourceRequest } from './review-curation';

const payload = {
  kind: 'review',
  reviewSnapshot: { headSha: 'a'.repeat(40) },
  lineComments: [{ path: 'src/example.ts', line: 2 }],
} as ReviewGatePayload;

test('finding inspection pins the reviewed SHA for both slot and standalone review', () => {
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
  let current = true;
  const params = reviewFindingSourceRequest('review-run', null, payload, 0)!;
  const client = {
    request: async (method: string, request: unknown) => {
      assert.equal(method, Methods.GIT_SHOW);
      assert.deepEqual(request, params);
      return { content: 'before\nReviewed value\nafter\n' };
    },
  };
  const context = await loadReviewFindingSource(client as never, params, 2, () => current);
  assert.deepEqual(
    context!.lines.find((line) => line.target),
    { number: 2, text: 'Reviewed value', target: true },
  );
  const stale = loadReviewFindingSource(client as never, params, 2, () => current);
  current = false;
  assert.equal(await stale, null);
});

test('missing reviewed files fail without a mutable-workspace fallback', async () => {
  let calls = 0;
  const client = {
    request: async () => {
      calls++;
      throw new Error('Object unavailable');
    },
  };
  await assert.rejects(
    loadReviewFindingSource(
      client as never,
      reviewFindingSourceRequest('run', 'slot', payload, 0)!,
      2,
      () => true,
    ),
    /Object unavailable/,
  );
  assert.equal(calls, 1);
});

test('selecting a line 462 finding uses the shared exact source-line context', () => {
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
